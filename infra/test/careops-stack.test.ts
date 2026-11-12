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

test('disables target group stickiness (any replica serves any request)', () => {
  synth().hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    TargetGroupAttributes: Match.arrayWith([
      Match.objectLike({ Key: 'stickiness.enabled', Value: 'false' }),
    ]),
  });
});

test('health check path is /api/health on the API port', () => {
  synth().hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    HealthCheckPath: '/api/health',
    Port: 3001,
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

test('desired count is parameterized', () => {
  synth({ desiredCount: 1 }).hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
  synth({ desiredCount: 4 }).hasResourceProperties('AWS::ECS::Service', { DesiredCount: 4 });
});

test('ALB is internet-facing', () => {
  synth().hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
  });
});

test('HTTP-only by default: no HTTPS listener without a certificate', () => {
  const template = synth();
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 80,
    Protocol: 'HTTP',
  });
});

test('ACM certificate adds an HTTPS listener and an HTTP->HTTPS redirect', () => {
  const template = synth({ certificateArn: CERT_ARN });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 443,
    Protocol: 'HTTPS',
    Certificates: [{ CertificateArn: CERT_ARN }],
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Actions: [
      Match.objectLike({
        Type: 'redirect',
        RedirectConfig: Match.objectLike({
          Protocol: 'HTTPS',
          Port: '443',
          StatusCode: 'HTTP_301',
        }),
      }),
    ],
  });
  // /api/* still routes to the API, now on the HTTPS listener.
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*'] } }],
    Actions: [Match.objectLike({ Type: 'forward' })],
  });
});

test('provisions ECR, ElastiCache Redis and a CloudWatch log group', () => {
  const template = synth();
  template.resourceCountIs('AWS::ECR::Repository', 1);
  template.resourceCountIs('AWS::ElastiCache::CacheCluster', 1);
  template.resourceCountIs('AWS::Logs::LogGroup', 1);
  template.hasResourceProperties('AWS::ElastiCache::CacheCluster', { Engine: 'redis' });
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
