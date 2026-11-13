import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CareOpsStack, type CareOpsStackProps } from '../lib/careops-stack.js';

const CERT_ARN = 'arn:aws:acm:us-east-1:000000000000:certificate/tracer-bullet';

// Env-agnostic App: synth uses placeholder AZs and needs no credentials.
function synth(overrides: Partial<CareOpsStackProps> = {}): Template {
  const app = new App();
  const stack = new CareOpsStack(app, 'TestStack', {
    target: 'aws',
    desiredCount: 1,
    imageTag: 'latest',
    ...overrides,
  });
  return Template.fromStack(stack);
}

interface ContainerDef {
  Environment?: { Name: string; Value: unknown }[];
  Secrets?: { Name: string; ValueFrom: unknown }[];
}
interface TaskDefResource {
  Properties: { ContainerDefinitions: ContainerDef[] };
}
interface SecretResource {
  Properties: { SecretString?: unknown };
}

const CREDENTIAL_VARS = ['MONGODB_URI', 'BETTER_AUTH_SECRET', 'SMTP_URL'];

test('routes /api/* to the API target group', () => {
  synth().hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }],
    Actions: [
      Match.objectLike({
        Type: 'forward',
        TargetGroupArn: { Ref: Match.stringLikeRegexp('ApiTargetGroup') },
      }),
    ],
  });
});

test('disables target group stickiness on BOTH tiers (any replica serves any request)', () => {
  const groups = synth().findResources('AWS::ElasticLoadBalancingV2::TargetGroup') as Record<
    string,
    { Properties: { TargetGroupAttributes?: Array<{ Key: string; Value: string }> } }
  >;
  assert.ok(Object.keys(groups).length >= 2, 'expected API and web target groups');
  for (const [id, group] of Object.entries(groups)) {
    const stickiness = (group.Properties.TargetGroupAttributes ?? []).find(
      (attr) => attr.Key === 'stickiness.enabled',
    );
    assert.equal(stickiness?.Value, 'false', `${id} must have stickiness disabled`);
  }
});

test('health check path is /api/health on the API port', () => {
  synth().hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    HealthCheckPath: '/api/health',
    Port: 3001,
    Protocol: 'HTTP',
    TargetType: 'ip',
  });
});

test('web target group health-checks /healthz on the web port', () => {
  synth().hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    HealthCheckPath: '/healthz',
    Port: 3000,
    Protocol: 'HTTP',
    TargetType: 'ip',
  });
});

test('injects credentials as runtime secrets, never plaintext environment', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: [
      Match.objectLike({
        Secrets: Match.arrayWith([
          Match.objectLike({
            Name: 'MONGODB_URI',
            ValueFrom: { Ref: Match.stringLikeRegexp('MongoUri') },
          }),
          Match.objectLike({
            Name: 'BETTER_AUTH_SECRET',
            ValueFrom: { Ref: Match.stringLikeRegexp('BetterAuthSecret') },
          }),
          Match.objectLike({
            Name: 'SMTP_URL',
            ValueFrom: { Ref: Match.stringLikeRegexp('SmtpUrl') },
          }),
        ]),
      }),
    ],
  });

  const taskDefs = template.findResources('AWS::ECS::TaskDefinition') as Record<
    string,
    TaskDefResource
  >;
  for (const taskDef of Object.values(taskDefs)) {
    for (const container of taskDef.Properties.ContainerDefinitions) {
      const envNames = (container.Environment ?? []).map((entry) => entry.Name);
      for (const name of CREDENTIAL_VARS) {
        assert.ok(
          !envNames.includes(name),
          `${name} must resolve from Secrets Manager, not plaintext env`,
        );
      }
    }
  }
});

test('secret resources carry no inline value in the template', () => {
  const secrets = synth().findResources('AWS::SecretsManager::Secret') as Record<
    string,
    SecretResource
  >;
  assert.ok(Object.keys(secrets).length >= 3, 'expected Mongo, BetterAuth and SMTP secrets');
  for (const secret of Object.values(secrets)) {
    assert.equal(secret.Properties.SecretString, undefined, 'secret value must not be inline');
  }
});

test('desired count is parameterized on both tiers', () => {
  synth({ desiredCount: 4 }).hasResourceProperties('AWS::ECS::Service', { DesiredCount: 4 });
  synth({ webDesiredCount: 2 }).hasResourceProperties('AWS::ECS::Service', { DesiredCount: 2 });
  // Defaults: one replica per tier.
  const services = synth().findResources('AWS::ECS::Service') as Record<
    string,
    { Properties: { DesiredCount: number } }
  >;
  assert.equal(Object.keys(services).length, 2, 'API and web services');
  for (const service of Object.values(services)) {
    assert.equal(service.Properties.DesiredCount, 1);
  }
});

test('auto-scaling bounds are parameterized on both tiers (minCapacity/maxCapacity)', () => {
  const scalableTargets = (template: Template) =>
    template.findResources('AWS::ApplicationAutoScaling::ScalableTarget') as Record<
      string,
      {
        Properties: {
          MinCapacity: number;
          MaxCapacity: number;
          ScalableDimension: string;
          ServiceNamespace: string;
        };
      }
    >;
  const bounds = (template: Template): Array<[number, number]> =>
    Object.values(scalableTargets(template)).map((target) => [
      target.Properties.MinCapacity,
      target.Properties.MaxCapacity,
    ]);
  const sameBounds = (pairs: Array<[number, number]>, min: number, max: number): boolean =>
    pairs.length === 2 && pairs.every(([lo, hi]) => lo === min && hi === max);

  // Defaults: both tiers 1..4.
  const defaults = bounds(synth());
  assert.equal(defaults.length, 2, 'one scalable target per tier');
  assert.equal(
    defaults.every(([d]) => d === 1),
    true,
    'floors default to 1',
  );
  assert.equal(
    defaults.every(([, hi]) => hi === 4),
    true,
    'ceilings default to 4',
  );
  for (const target of Object.values(scalableTargets(synth()))) {
    assert.equal(target.Properties.ScalableDimension, 'ecs:service:DesiredCount');
    assert.equal(target.Properties.ServiceNamespace, 'ecs');
  }

  // API ramp override moves only the API tier.
  assert.deepEqual(
    bounds(synth({ minCapacity: 2, maxCapacity: 8 })).sort((a, b) => a[0] - b[0]),
    [
      [1, 4],
      [2, 8],
    ],
  );
  // Web ramp override moves only the web tier.
  assert.ok(sameBounds(bounds(synth({ webMinCapacity: 3, webMaxCapacity: 6 })), 1, 4) === false);
  const webRamped = bounds(synth({ webMinCapacity: 3, webMaxCapacity: 6 })).sort(
    (a, b) => a[0] - b[0],
  );
  assert.deepEqual(webRamped, [
    [1, 4],
    [3, 6],
  ]);
});

test('target-tracking policies scale both tiers on CPU and ALB requests per target', () => {
  const policies = synth().findResources('AWS::ApplicationAutoScaling::ScalingPolicy') as Record<
    string,
    {
      Properties: {
        PolicyType: string;
        TargetTrackingScalingPolicyConfiguration: {
          TargetValue: number;
          PredefinedMetricSpecification: { PredefinedMetricType: string; ResourceLabel?: unknown };
        };
      };
    }
  >;
  const tracking = Object.values(policies).filter(
    (policy) => policy.Properties.PolicyType === 'TargetTrackingScaling',
  );
  const byMetric = (type: string) =>
    tracking.filter(
      (policy) =>
        policy.Properties.TargetTrackingScalingPolicyConfiguration.PredefinedMetricSpecification
          .PredefinedMetricType === type,
    );
  // One CPU + one request-count policy per tier.
  assert.equal(byMetric('ECSServiceAverageCPUUtilization').length, 2);
  const requestPolicies = byMetric('ALBRequestCountPerTarget');
  assert.equal(requestPolicies.length, 2);
  for (const policy of tracking) {
    assert.ok(policy.Properties.TargetTrackingScalingPolicyConfiguration.TargetValue > 0);
  }
  // Each request-count policy names its tier's ALB+TG resource label; the two
  // labels must differ (API vs web target group).
  const labels = requestPolicies.map(
    (policy) =>
      policy.Properties.TargetTrackingScalingPolicyConfiguration.PredefinedMetricSpecification
        .ResourceLabel,
  );
  for (const label of labels) assert.ok(label, 'request policy must carry the resource label');
  assert.notEqual(labels[0], labels[1], 'API and web policies must watch different targets');
});

test('ALB is internet-facing', () => {
  synth().hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
  });
});

test('ALB is an HTTP-only origin: /* defaults to web, /api/* peels off to the API', () => {
  const template = synth();
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 80,
    Protocol: 'HTTP',
    DefaultActions: [Match.objectLike({ Type: 'forward' })],
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Priority: 10,
    Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }],
    Actions: [
      Match.objectLike({
        Type: 'forward',
        TargetGroupArn: { Ref: Match.stringLikeRegexp('ApiTargetGroup') },
      }),
    ],
  });
  // TLS is CloudFront's job now (ADR-0012): no ALB HTTPS listener exists even
  // when a certificate is configured.
  const withCert = synth({ certificateArn: CERT_ARN, domainName: 'app.example.com' });
  withCert.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
});

// Managed policy IDs are stable AWS values (CachingDisabled / CachingOptimized /
// AllViewerExceptHostHeader).
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

test('CloudFront fronts the ALB over HTTP with dynamic behaviors that never cache', () => {
  const template = synth();
  template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      PriceClass: 'PriceClass_100',
      Origins: [
        Match.objectLike({
          CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: 'http-only' }),
        }),
      ],
      DefaultCacheBehavior: Match.objectLike({
        CachePolicyId: CACHING_DISABLED,
        OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
        ViewerProtocolPolicy: 'redirect-to-https',
        AllowedMethods: Match.arrayWith(['POST']),
      }),
    }),
  });
});

test('CloudFront caches /assets/* hard and never caches /api/* or SSR', () => {
  const template = synth();
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      CacheBehaviors: Match.arrayWith([
        // API: uncached, cookies + query strings forwarded, all methods.
        Match.objectLike({
          PathPattern: '/api/*',
          CachePolicyId: CACHING_DISABLED,
          OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
        // Hashed static assets: cached hard, NO cookie/origin-request policy —
        // they are session-independent by construction.
        Match.objectLike({
          PathPattern: '/assets/*',
          CachePolicyId: CACHING_OPTIMIZED,
          OriginRequestPolicyId: Match.absent(),
          AllowedMethods: ['GET', 'HEAD'],
        }),
      ]),
    }),
  });
});

test('CloudFront attaches the ACM certificate and domain when both are configured', () => {
  const plain = synth().findResources('AWS::CloudFront::Distribution') as Record<
    string,
    { Properties: { DistributionConfig: { Aliases?: unknown; ViewerCertificate?: unknown } } }
  >;
  for (const dist of Object.values(plain)) {
    assert.equal(dist.Properties.DistributionConfig.Aliases, undefined);
  }

  const custom = synth({ certificateArn: CERT_ARN, domainName: 'app.example.com' });
  custom.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      Aliases: ['app.example.com'],
      ViewerCertificate: Match.objectLike({
        AcmCertificateArn: CERT_ARN,
        SslSupportMethod: 'sni-only',
      }),
    }),
  });
});

test('provisions both ECR repos, ElastiCache Redis and a CloudWatch log group', () => {
  const template = synth();
  template.resourceCountIs('AWS::ECR::Repository', 2);
  template.resourceCountIs('AWS::ElastiCache::CacheCluster', 1);
  template.resourceCountIs('AWS::Logs::LogGroup', 1);
  template.hasResourceProperties('AWS::ElastiCache::CacheCluster', { Engine: 'redis' });
});

test('web task runs with no secrets at all (the browser owns the API session)', () => {
  const template = synth();
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition') as Record<
    string,
    TaskDefResource
  >;
  const web = Object.values(taskDefs).find((taskDef) =>
    (taskDef.Properties.ContainerDefinitions ?? []).some((container) =>
      (container.Environment ?? []).some(
        (env) => env.Name === 'PORT' && String(env.Value) === '3000',
      ),
    ),
  );
  assert.ok(web, 'expected the web task definition (PORT=3000)');
  for (const container of web.Properties.ContainerDefinitions) {
    assert.equal(container.Secrets, undefined, 'web container must carry no Secrets');
    const names = (container.Environment ?? []).map((entry) => entry.Name);
    for (const name of CREDENTIAL_VARS) {
      assert.ok(!names.includes(name), `${name} must never appear in the web container`);
    }
  }
});

test('API task pins same-origin auth to the app origin when a domain is set', () => {
  synth({ domainName: 'app.example.com' }).hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: [
      Match.objectLike({
        Environment: Match.arrayWith([
          { Name: 'BETTER_AUTH_URL', Value: 'https://app.example.com' },
          { Name: 'BETTER_AUTH_TRUSTED_ORIGINS', Value: 'https://app.example.com' },
        ]),
      }),
    ],
  });
  // Without a domain, the auth-origin vars stay absent (no invented origin).
  const template = synth();
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition') as Record<
    string,
    TaskDefResource
  >;
  for (const taskDef of Object.values(taskDefs)) {
    for (const container of taskDef.Properties.ContainerDefinitions) {
      const names = (container.Environment ?? []).map((entry) => entry.Name);
      assert.ok(!names.includes('BETTER_AUTH_URL'), 'no domain set: no pinned auth origin');
    }
  }
});

test('aws target derives REDIS_URL from ElastiCache; floci target uses compose Redis', () => {
  const aws = synth({ target: 'aws' });
  aws.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: [
      Match.objectLike({
        Environment: Match.arrayWith([
          Match.objectLike({
            Name: 'REDIS_URL',
            Value: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
          }),
        ]),
      }),
    ],
  });

  const floci = synth({ target: 'floci' });
  floci.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: [
      Match.objectLike({
        Environment: Match.arrayWith([
          { Name: 'REDIS_URL', Value: 'redis://host.docker.internal:6379' },
        ]),
      }),
    ],
  });
});

test('private-subnet Fargate tasks with a deployment circuit breaker', () => {
  synth().hasResourceProperties('AWS::ECS::Service', {
    LaunchType: 'FARGATE',
    DeploymentConfiguration: Match.objectLike({
      DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      MinimumHealthyPercent: 100,
    }),
    NetworkConfiguration: Match.objectLike({ AwsvpcConfiguration: { AssignPublicIp: 'DISABLED' } }),
  });
});
