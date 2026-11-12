#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { CareOpsStack, type CareOpsStackProps, type DeployTarget } from '../lib/careops-stack.js';

const app = new App();

// Target selects AWS vs the Floci emulator; desiredCount is parameterized so the
// same stack serves the one-replica tracer bullet and later scale-out (W3-T4).
const target = (app.node.tryGetContext('target') ??
  process.env.CAREOPS_DEPLOY_TARGET ??
  'aws') as DeployTarget;

const desiredCount = Number(
  app.node.tryGetContext('desiredCount') ?? process.env.CAREOPS_DESIRED_COUNT ?? 1,
);

const imageTag = (app.node.tryGetContext('imageTag') ??
  process.env.CAREOPS_IMAGE_TAG ??
  'latest') as string;

const certificateArn = (app.node.tryGetContext('certificateArn') ??
  process.env.CAREOPS_CERTIFICATE_ARN) as string | undefined;

const redisUrl = (app.node.tryGetContext('redisUrl') ?? process.env.CAREOPS_REDIS_URL) as
  string | undefined;

// Concrete env only when the CDK CLI resolves credentials (CDK_DEFAULT_*). With
// no credentials the stack stays env-agnostic so `cdk synth`/tests run offline.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

const props: CareOpsStackProps = {
  target,
  desiredCount,
  imageTag,
  ...(account && region ? { env: { account, region } } : {}),
  ...(certificateArn ? { certificateArn } : {}),
  ...(redisUrl ? { redisUrl } : {}),
};

// Skip the default-SG hardening Lambda on Floci: it calls EC2 over HTTPS, which the emulator (HTTP:4566) doesn't serve. Explicit SGs are used.
app.node.setContext('@aws-cdk/aws-ec2:restrictDefaultSecurityGroup', target === 'aws');

new CareOpsStack(app, 'CareOpsStack', props);
