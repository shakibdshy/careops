#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { CareOpsStack, type CareOpsStackProps, type DeployTarget } from '../lib/careops-stack.js';

const app = new App();

// One reader for all `-c` context flags with their CAREOPS_* env fallbacks —
// keeps the precedence (context > env > default) in a single place.
const readFlag = (key: string, envVar: string): string | undefined =>
  (app.node.tryGetContext(key) as string | undefined) ?? process.env[envVar];

// Target selects AWS vs the Floci emulator; desiredCount is parameterized so the
// same stack serves the one-replica tracer bullet and later scale-out (W3-T4).
const targetFlag = readFlag('target', 'CAREOPS_DEPLOY_TARGET') ?? 'aws';
if (targetFlag !== 'aws' && targetFlag !== 'floci') {
  throw new Error(`invalid target "${targetFlag}" — expected "aws" or "floci" (-c target=…)`);
}
const target: DeployTarget = targetFlag;

const desiredCount = Number(readFlag('desiredCount', 'CAREOPS_DESIRED_COUNT') ?? 1);

// Auto-scaling bounds (W3-T3). minCapacity doubles as the k6-ramp lever: redeploy
// -c minCapacity=N to hold N replicas for a ramp stage.
const minCapacity = Number(readFlag('minCapacity', 'CAREOPS_MIN_CAPACITY') ?? 1);
const maxCapacity = Number(readFlag('maxCapacity', 'CAREOPS_MAX_CAPACITY') ?? 4);
if (!Number.isInteger(minCapacity) || !Number.isInteger(maxCapacity) || maxCapacity < minCapacity) {
  throw new Error(
    `invalid scaling bounds: min=${minCapacity} max=${maxCapacity} (integers, max ≥ min)`,
  );
}

const imageTag = readFlag('imageTag', 'CAREOPS_IMAGE_TAG') ?? 'latest';

const certificateArn = readFlag('certificateArn', 'CAREOPS_CERTIFICATE_ARN');

const redisUrl = readFlag('redisUrl', 'CAREOPS_REDIS_URL');

// Concrete env only when the CDK CLI resolves credentials (CDK_DEFAULT_*). With
// no credentials the stack stays env-agnostic so `cdk synth`/tests run offline.
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

const props: CareOpsStackProps = {
  target,
  desiredCount,
  minCapacity,
  maxCapacity,
  imageTag,
  ...(account && region ? { env: { account, region } } : {}),
  ...(certificateArn ? { certificateArn } : {}),
  ...(redisUrl ? { redisUrl } : {}),
};

// Skip the default-SG hardening Lambda on Floci: it calls EC2 over HTTPS, which the emulator (HTTP:4566) doesn't serve. Explicit SGs are used.
app.node.setContext('@aws-cdk/aws-ec2:restrictDefaultSecurityGroup', target === 'aws');

new CareOpsStack(app, 'CareOpsStack', props);
