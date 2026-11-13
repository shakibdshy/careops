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
  ListenerCertificate,
  ListenerCondition,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type { ApplicationListener } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { CfnCacheCluster, CfnSubnetGroup } from 'aws-cdk-lib/aws-elasticache';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

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
  /** ACM certificate ARN. When set, the ALB serves HTTPS and redirects HTTP. */
  readonly certificateArn?: string;
  /** Override the Redis URL. Defaults to ElastiCache (aws) or compose (floci). */
  readonly redisUrl?: string;
}

const API_PORT = 3001;
const HEALTH_PATH = '/api/health';

/**
 * CareOps deploy stack (ADR-0012): one stateless API Fargate tier behind an
 * internet-facing ALB, ElastiCache Redis, and an Atlas URI secret. The same
 * stack targets real AWS and the Floci emulator; `target` switches only the
 * data-plane connection details, never the topology. Secrets are created empty
 * and populated out-of-band so no credential ever lands in the template/repo.
 */
export class CareOpsStack extends Stack {
  readonly vpc: Vpc;
  readonly apiRepository: Repository;
  readonly loadBalancer: ApplicationLoadBalancer;
  readonly targetGroup: ApplicationTargetGroup;
  readonly service: FargateService;
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
    const redisUrl =
      props.redisUrl ??
      (props.target === 'floci'
        ? 'redis://host.docker.internal:6379'
        : `redis://${cache.attrRedisEndpointAddress}:${cache.attrRedisEndpointPort}`);

    const healthProbe =
      "node -e \"fetch('http://127.0.0.1:3001/api/health')" +
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

    // --- Load balancer: /api/* -> API, stickiness OFF, /api/health ---------
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

    const notFound = ListenerAction.fixedResponse(404, {
      contentType: 'text/plain',
      messageBody: 'Not Found',
    });
    const httpListener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      defaultAction: notFound,
    });

    // One /api/* forward rule, attached to whichever listener terminates TLS.
    const addApiRoute = (listener: ApplicationListener): void => {
      listener.addAction('ApiRoute', {
        priority: 10,
        conditions: [ListenerCondition.pathPatterns(['/api/*'])],
        action: ListenerAction.forward([this.targetGroup]),
      });
    };

    if (props.certificateArn) {
      const httpsListener = this.loadBalancer.addListener('HttpsListener', {
        port: 443,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [ListenerCertificate.fromArn(props.certificateArn)],
        defaultAction: notFound,
      });
      addApiRoute(httpsListener);
      httpListener.addAction('HttpsRedirect', {
        priority: 1,
        conditions: [ListenerCondition.pathPatterns(['/*'])],
        action: ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
    } else {
      addApiRoute(httpListener);
    }

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

    // --- Outputs -----------------------------------------------------------
    const scheme = props.certificateArn ? 'https' : 'http';
    new CfnOutput(this, 'ApiHealthUrl', {
      value: `${scheme}://${this.loadBalancer.loadBalancerDnsName}${HEALTH_PATH}`,
      description: 'Public API health endpoint',
    });
    new CfnOutput(this, 'AlbDnsName', { value: this.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, 'EcrRepositoryUri', { value: this.apiRepository.repositoryUri });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'ServiceName', { value: this.service.serviceName });
    new CfnOutput(this, 'MongoSecretArn', { value: this.mongoSecret.secretArn });
    new CfnOutput(this, 'BetterAuthSecretArn', { value: this.authSecret.secretArn });
    new CfnOutput(this, 'SmtpSecretArn', { value: this.smtpSecret.secretArn });
  }
}
