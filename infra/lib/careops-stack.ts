import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  GatewayVpcEndpointAwsService,
  InterfaceVpcEndpointAwsService,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import {
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
  LogDriver,
  Protocol,
  Secret as EcsSecret,
} from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { CfnCacheCluster, CfnSubnetGroup } from 'aws-cdk-lib/aws-elasticache';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CachePolicy as ManagedCachePolicy,
  Distribution,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  PriceClass,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { LoadBalancerV2Origin } from 'aws-cdk-lib/aws-cloudfront-origins';

export type DeployTarget = 'aws' | 'floci';

export interface CareOpsStackProps extends StackProps {
  /** AWS production vs the Floci emulator (ADR-0012). Switches the data plane. */
  readonly target: DeployTarget;
  /** API replica count. One for the tracer bullet; W3-T4 ramps it. */
  readonly desiredCount: number;
  /** Auto-scaling floor (replicas). The k6-ramp lever: redeploy `-c minCapacity=N`. */
  readonly minCapacity?: number;
  /** Auto-scaling ceiling (replicas) for both target-tracking policies. */
  readonly maxCapacity?: number;
  /** ECR image tag to deploy (the W3-T1 API image). */
  readonly imageTag: string;
  /** ECR image tag for the W3-T4 web SSR image. */
  readonly webImageTag?: string;
  /** Web SSR replica count (defaults to 1). */
  readonly webDesiredCount?: number;
  /** Web auto-scaling floor. The ramp lever for the web tier. */
  readonly webMinCapacity?: number;
  /** Web auto-scaling ceiling. */
  readonly webMaxCapacity?: number;
  /** ACM certificate ARN (us-east-1) for the CloudFront viewer certificate. */
  readonly certificateArn?: string;
  /** Custom domain for the CloudFront distribution (requires certificateArn). */
  readonly domainName?: string;
  /** Override the Redis URL. Defaults to ElastiCache (aws) or compose (floci). */
  readonly redisUrl?: string;
}

const API_PORT = 3001;
const HEALTH_PATH = '/api/health';
const WEB_PORT = 3000;
const WEB_HEALTH_PATH = '/healthz';

/**
 * CareOps deploy stack (ADR-0012): a stateless API tier and an SSR web tier on
 * Fargate behind ONE internet-facing ALB (path-routed, same-origin), fronted
 * by CloudFront; ElastiCache Redis and an Atlas URI secret behind them. The
 * same stack targets real AWS and the Floci emulator; `target` switches only
 * the data-plane connection details, never the topology. Secrets are created
 * empty and populated out-of-band so no credential ever lands in the
 * template/repo.
 */
export class CareOpsStack extends Stack {
  readonly vpc: Vpc;
  readonly apiRepository: Repository;
  readonly webRepository: Repository;
  readonly loadBalancer: ApplicationLoadBalancer;
  readonly targetGroup: ApplicationTargetGroup;
  readonly webTargetGroup: ApplicationTargetGroup;
  readonly service: FargateService;
  readonly webService: FargateService;
  readonly distribution: Distribution;
  readonly mongoSecret: Secret;
  readonly authSecret: Secret;
  readonly smtpSecret: Secret;

  constructor(scope: Construct, id: string, props: CareOpsStackProps) {
    super(scope, id, props);

    // --- Network -----------------------------------------------------------
    // maxAzs (not explicit AZs): an env-agnostic synth uses placeholder AZs and
    // needs no credentials; `cdk deploy` resolves the account's real AZs.
    this.vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // Private-subnet egress to AWS services without traversing the NAT:
    // ECR (image pull), S3 (ECR layers), Secrets Manager, CloudWatch Logs.
    // The NAT remains for the public Atlas endpoint.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: InterfaceVpcEndpointAwsService.ECR,
    });
    this.vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
      service: InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });
    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });

    // --- Registry ----------------------------------------------------------
    this.apiRepository = new Repository(this, 'ApiRepository', {
      repositoryName: 'careops-api',
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
    this.webRepository = new Repository(this, 'WebRepository', {
      repositoryName: 'careops-web',
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // --- Secrets (empty shells; populated out-of-band, never inline) --------
    this.mongoSecret = new Secret(this, 'MongoUri', {
      secretName: 'careops/mongodb-uri',
      description: 'MongoDB Atlas connection URI. Populate after deploy.',
    });
    this.authSecret = new Secret(this, 'BetterAuthSecret', {
      secretName: 'careops/better-auth-secret',
      description: 'BetterAuth signing secret (>=32 chars). Populate after deploy.',
    });
    this.smtpSecret = new Secret(this, 'SmtpUrl', {
      secretName: 'careops/smtp-url',
      description: 'SMTP transport URL. Populate after deploy.',
    });

    // --- Data: ElastiCache Redis (shared cache + queue, ADR-0011) ----------
    const cacheSubnets = new CfnSubnetGroup(this, 'CacheSubnets', {
      description: 'CareOps Redis private subnets',
      subnetIds: this.vpc.privateSubnets.map((subnet) => subnet.subnetId),
    });
    const cacheSg = new SecurityGroup(this, 'CacheSg', {
      vpc: this.vpc,
      description: 'CareOps ElastiCache Redis',
      allowAllOutbound: false,
    });
    const cache = new CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      port: 6379,
      cacheSubnetGroupName: cacheSubnets.ref,
      vpcSecurityGroupIds: [cacheSg.securityGroupId],
    });

    // --- Observability -----------------------------------------------------
    const logGroup = new LogGroup(this, 'ApiLogs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Compute: one API Fargate replica (desiredCount parameterized) -----
    const cluster = new Cluster(this, 'Cluster', {
      vpc: this.vpc,
      clusterName: 'careops',
    });
    const taskDef = new FargateTaskDefinition(this, 'ApiTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    // Floci tasks run on Floci's own Docker network, not the compose network, so
    // compose services are reached via the host gateway (Docker Desktop/OrbStack).
    // The public app origin, when the operator names a custom domain: feeds
    // better-auth's cookie policy + trusted origins for same-origin auth.
    const appUrl = props.domainName ? `https://${props.domainName}` : undefined;
    const redisUrl =
      props.redisUrl ??
      (props.target === 'floci'
        ? 'redis://host.docker.internal:6379'
        : `redis://${cache.attrRedisEndpointAddress}:${cache.attrRedisEndpointPort}`);

    const healthProbe =
      `node -e "fetch('http://127.0.0.1:${API_PORT}${HEALTH_PATH}')` +
      '.then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"';

    taskDef.addContainer('api', {
      image: ContainerImage.fromEcrRepository(this.apiRepository, props.imageTag),
      logging: LogDriver.awsLogs({ logGroup, streamPrefix: 'api' }),
      portMappings: [{ containerPort: API_PORT, protocol: Protocol.TCP }],
      environment: {
        NODE_ENV: 'production',
        PORT: String(API_PORT),
        REDIS_URL: redisUrl,
        MAIL_FROM: 'CareOps <no-reply@careops.local>',
        NOTIFICATIONS_QUEUE_NAME: 'notifications',
        // The public app origin (W3-T4 same-origin auth): better-auth pins its
        // cookie policy + trusted origins to it. Set alongside domainName.
        ...(appUrl ? { BETTER_AUTH_URL: appUrl, BETTER_AUTH_TRUSTED_ORIGINS: appUrl } : {}),
      },
      // Credentials resolve at runtime from Secrets Manager — never plaintext.
      secrets: {
        MONGODB_URI: EcsSecret.fromSecretsManager(this.mongoSecret),
        BETTER_AUTH_SECRET: EcsSecret.fromSecretsManager(this.authSecret),
        SMTP_URL: EcsSecret.fromSecretsManager(this.smtpSecret),
      },
      healthCheck: {
        command: ['CMD-SHELL', healthProbe],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
    });

    const serviceSg = new SecurityGroup(this, 'ApiServiceSg', {
      vpc: this.vpc,
      description: 'CareOps API Fargate tasks',
      allowAllOutbound: true,
    });
    cacheSg.addIngressRule(serviceSg, Port.tcp(6379), 'API to Redis');

    this.service = new FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: props.desiredCount,
      assignPublicIp: false,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSg],
      healthCheckGracePeriod: Duration.seconds(60),
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
    });

    // --- Load balancer: one origin for both tiers, stickiness OFF ----------
    // HTTP-only on purpose: TLS terminates at CloudFront (ADR-0012, W3-T4) —
    // an ALB HTTPS listener/redirect here would break the edge origin path.
    this.loadBalancer = new ApplicationLoadBalancer(this, 'Alb', {
      vpc: this.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
    });
    this.targetGroup = new ApplicationTargetGroup(this, 'ApiTargetGroup', {
      vpc: this.vpc,
      port: API_PORT,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      // Stickiness is disabled by omission: no stickinessCookieDuration is set,
      // so any replica serves any request (statelessness, ADR-0006/0007/0011).
      healthCheck: {
        path: HEALTH_PATH,
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
    this.service.attachToApplicationTargetGroup(this.targetGroup);
    this.service.connections.allowFrom(this.loadBalancer, Port.tcp(API_PORT), 'ALB to API');

    // Web SSR tier: same task pattern, no secrets (the browser talks to the API
    // same-origin; the SSR handler renders shells and never calls the API).
    const webTaskDef = new FargateTaskDefinition(this, 'WebTask', {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    const webHealthProbe =
      `node -e "fetch('http://127.0.0.1:${WEB_PORT}${WEB_HEALTH_PATH}')` +
      '.then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"';
    webTaskDef.addContainer('web', {
      image: ContainerImage.fromEcrRepository(this.webRepository, props.webImageTag ?? 'latest'),
      logging: LogDriver.awsLogs({ logGroup, streamPrefix: 'web' }),
      portMappings: [{ containerPort: WEB_PORT, protocol: Protocol.TCP }],
      environment: {
        NODE_ENV: 'production',
        PORT: String(WEB_PORT),
      },
      healthCheck: {
        command: ['CMD-SHELL', webHealthProbe],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
    });
    const webServiceSg = new SecurityGroup(this, 'WebServiceSg', {
      vpc: this.vpc,
      description: 'CareOps web SSR Fargate tasks',
      allowAllOutbound: true,
    });
    this.webService = new FargateService(this, 'WebService', {
      cluster,
      taskDefinition: webTaskDef,
      desiredCount: props.webDesiredCount ?? 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [webServiceSg],
      healthCheckGracePeriod: Duration.seconds(30),
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
    });

    this.webTargetGroup = new ApplicationTargetGroup(this, 'WebTargetGroup', {
      vpc: this.vpc,
      port: WEB_PORT,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      // Stickiness off by the same omission — any web replica serves any page.
      healthCheck: {
        path: WEB_HEALTH_PATH,
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
    this.webService.attachToApplicationTargetGroup(this.webTargetGroup);
    this.webService.connections.allowFrom(this.loadBalancer, Port.tcp(WEB_PORT), 'ALB to web');

    const httpListener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      // Default = the web tier: /* goes to SSR; the /api/* rule below peels the
      // API off first. One listener, one domain, same-origin by construction.
      defaultAction: ListenerAction.forward([this.webTargetGroup]),
    });
    // The /api/* rule (priority 10) outranks the /* default, so the API keeps
    // its namespace on the shared domain.
    httpListener.addAction('ApiRoute', {
      priority: 10,
      conditions: [ListenerCondition.pathPatterns(['/api/*'])],
      action: ListenerAction.forward([this.targetGroup]),
    });

    // --- Auto-scaling: target tracking on CPU + ALB requests per target -----
    // Placed after listener attachment: scaleOnRequestCount needs the target
    // group's ALB resource label, which only exists once a listener references
    // it. The scalable target owns DesiredCount once registered; `minCapacity`
    // is the k6-ramp lever (redeploy -c minCapacity=N pins the floor — scale-in
    // stops at min, so a stage holds exactly N replicas under load).
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: props.minCapacity ?? props.desiredCount,
      maxCapacity: props.maxCapacity ?? 4,
    });
    // 0.5 vCPU/task: CPU is the first exhausted resource under fan-out reads.
    scaling.scaleOnCpuUtilization('ScaleOnCpu', {
      targetUtilizationPercent: 60,
      scaleOutCooldown: Duration.seconds(60),
      scaleInCooldown: Duration.seconds(180),
    });
    // ALB request count per target covers the I/O-bound regime CPU misses
    // (report cache hits keep CPU low while request pressure keeps rising).
    scaling.scaleOnRequestCount('ScaleOnRequests', {
      requestsPerTarget: 500,
      targetGroup: this.targetGroup,
      scaleOutCooldown: Duration.seconds(60),
      scaleInCooldown: Duration.seconds(180),
    });

    // Web tier scales the same way; request-count target is looser (1k/target)
    // because most web volume is immutable hashed assets served cheaply.
    const webScaling = this.webService.autoScaleTaskCount({
      minCapacity: props.webMinCapacity ?? props.webDesiredCount ?? 1,
      maxCapacity: props.webMaxCapacity ?? 4,
    });
    webScaling.scaleOnCpuUtilization('ScaleOnCpu', {
      targetUtilizationPercent: 60,
      scaleOutCooldown: Duration.seconds(60),
      scaleInCooldown: Duration.seconds(180),
    });
    webScaling.scaleOnRequestCount('ScaleOnRequests', {
      requestsPerTarget: 1000,
      targetGroup: this.webTargetGroup,
      scaleOutCooldown: Duration.seconds(60),
      scaleInCooldown: Duration.seconds(180),
    });

    // --- CloudFront: TLS + static-asset caching in front of the ALB --------
    // Same-origin by construction: one edge domain serves /* (web, never
    // cached, cookies forwarded), /api/* (API, same policy) and /assets/*
    // (hashed static, cached hard, no cookies — session-independent by hash).
    // Viewer TLS: the CloudFront default domain's certificate, or the ACM cert
    // + custom domain when both props are set (ACM must be in us-east-1).
    const albOrigin = new LoadBalancerV2Origin(this.loadBalancer, {
      protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
    });
    // Dynamic/SSR/API: never cached, everything forwarded (cookies + query
    // strings; Host excluded via the managed policy so the ALB origin resolves).
    const dynamicBehavior = {
      cachePolicy: ManagedCachePolicy.CACHING_DISABLED,
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      compress: true,
    };
    this.distribution = new Distribution(this, 'Cdn', {
      comment: 'CareOps same-origin edge: SSR/API uncached, /assets/* immutable-cached',
      defaultBehavior: {
        origin: albOrigin,
        ...dynamicBehavior,
      },
      additionalBehaviors: {
        '/api/*': { origin: albOrigin, ...dynamicBehavior },
        '/assets/*': {
          origin: albOrigin,
          cachePolicy: ManagedCachePolicy.CACHING_OPTIMIZED,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          compress: true,
          // No origin-request policy: no cookies/headers/query reach the origin
          // for hashed assets — they are session-independent by construction.
        },
      },
      priceClass: PriceClass.PRICE_CLASS_100,
      ...(props.certificateArn && props.domainName
        ? {
            certificate: Certificate.fromCertificateArn(this, 'EdgeCert', props.certificateArn),
            domainNames: [props.domainName],
          }
        : {}),
    });

    // --- Outputs -----------------------------------------------------------
    new CfnOutput(this, 'AppUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Same-origin app entry (web + API behind CloudFront)',
    });
    new CfnOutput(this, 'ApiHealthUrl', {
      value: `https://${this.distribution.distributionDomainName}${HEALTH_PATH}`,
      description: 'Public API health endpoint (through the edge)',
    });
    new CfnOutput(this, 'AlbDnsName', { value: this.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, 'EcrRepositoryUri', { value: this.apiRepository.repositoryUri });
    new CfnOutput(this, 'WebEcrRepositoryUri', { value: this.webRepository.repositoryUri });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'ServiceName', { value: this.service.serviceName });
    new CfnOutput(this, 'WebServiceName', { value: this.webService.serviceName });
    new CfnOutput(this, 'MongoSecretArn', { value: this.mongoSecret.secretArn });
    new CfnOutput(this, 'BetterAuthSecretArn', { value: this.authSecret.secretArn });
    new CfnOutput(this, 'SmtpSecretArn', { value: this.smtpSecret.secretArn });
  }
}
