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

// Auto-scaling bounds (W3-T3/W3-T4). minCapacity doubles as the ramp lever:
// redeploy -c minCapacity=N to hold N replicas for a stage — desiredCount then
// defaults to the floor, so `-c minCapacity=N` alone is a complete stage.
const minCapacity = Number(readFlag('minCapacity', 'CAREOPS_MIN_CAPACITY') ?? 1);
const desiredCount = Number(readFlag('desiredCount', 'CAREOPS_DESIRED_COUNT') ?? minCapacity);
const maxCapacity = Number(readFlag('maxCapacity', 'CAREOPS_MAX_CAPACITY') ?? 4);

// Same bounds contract for the web SSR tier (W3-T4), independent of the API tier.
const webMinCapacity = Number(readFlag('webMinCapacity', 'CAREOPS_WEB_MIN_CAPACITY') ?? 1);
const webDesiredCount = Number(
  readFlag('webDesiredCount', 'CAREOPS_WEB_DESIRED_COUNT') ?? webMinCapacity,
);
const webMaxCapacity = Number(readFlag('webMaxCapacity', 'CAREOPS_WEB_MAX_CAPACITY') ?? 4);

const boundsOf = (min: number, desired: number, max: number): boolean =>
  Number.isInteger(min) &&
  Number.isInteger(desired) &&
  Number.isInteger(max) &&
  min <= desired &&
  desired <= max;
if (!boundsOf(minCapacity, desiredCount, maxCapacity)) {
  throw new Error(
    `inconsistent API replica bounds: desired=${desiredCount} min=${minCapacity} max=${maxCapacity} (integers, min ≤ desired ≤ max)`,
  );
}
if (!boundsOf(webMinCapacity, webDesiredCount, webMaxCapacity)) {
  throw new Error(
    `inconsistent web replica bounds: desired=${webDesiredCount} min=${webMinCapacity} max=${webMaxCapacity} (integers, min ≤ desired ≤ max)`,
  );
}

const imageTag = readFlag('imageTag', 'CAREOPS_IMAGE_TAG') ?? 'latest';
const webImageTag = readFlag('webImageTag', 'CAREOPS_WEB_IMAGE_TAG') ?? 'latest';
const domainName = readFlag('domainName', 'CAREOPS_DOMAIN_NAME');

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
  webImageTag,
  webDesiredCount,
  webMinCapacity,
  webMaxCapacity,
  ...(account && region ? { env: { account, region } } : {}),
  ...(certificateArn ? { certificateArn } : {}),
  ...(domainName ? { domainName } : {}),
  ...(redisUrl ? { redisUrl } : {}),
};

// Skip the default-SG hardening Lambda on Floci: it calls EC2 over HTTPS, which the emulator (HTTP:4566) doesn't serve. Explicit SGs are used.
app.node.setContext('@aws-cdk/aws-ec2:restrictDefaultSecurityGroup', target === 'aws');

new CareOpsStack(app, 'CareOpsStack', props);
