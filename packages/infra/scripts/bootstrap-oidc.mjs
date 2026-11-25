#!/usr/bin/env node
// One-command AWS bootstrap for the OIDC pipeline (W3-T5). Idempotent: safe to
// re-run. Requires ANY valid AWS credential ONCE — this is the bootstrap that
// makes every later deploy keyless (GitHub assumes the role this creates via
// OIDC; no static keys ever live in the repo).
//
//   AWS_REGION=us-east-1 node infra/scripts/bootstrap-oidc.mjs
//
// Steps: (1) create the GitHub OIDC identity provider if absent, (2) create
// (or update the trust policy of) the `careops-github-deploy` role restricted
// to repo shakibdshy/careops main + workflow_dispatch, (3) attach an inline
// policy scoped to what the stack + CDK actually touch, (4) print the role
// ARN — set it as the GitHub variable AWS_DEPLOY_ROLE_ARN (the script prints
// the exact `gh variable set` command; run it, or pass --set to run it here).

import {
  IAMClient,
  CreateOpenIDConnectProviderCommand,
  GetOpenIDConnectProviderCommand,
  CreateRoleCommand,
  GetRoleCommand,
  TagRoleCommand,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const REPO = process.env.GITHUB_REPO ?? 'shakibdshy/careops';
const ROLE_NAME = 'careops-github-deploy';
const PROVIDER_URL = 'token.actions.githubusercontent.com';
const SET_GH_VAR = process.argv.includes('--set');

const config = { region: REGION };
const iam = new IAMClient(config);
const sts = new STSClient(config);

const log = (step, detail = '') => console.log(`  [${step}] ${detail}`);
const die = (message) => {
  console.error(`bootstrap FAILED: ${message}`);
  process.exit(1);
};

const identity = await sts
  .send(new GetCallerIdentityCommand({}))
  .catch((error) =>
    die(
      `no usable AWS credentials (${error.name}) — this bootstrap needs a valid credential ONCE; ` +
        'run it with AWS credentials configured (aws CLI login, SSO, or env keys). ' +
        'Every deploy AFTER this is keyless OIDC.',
    ),
  );
const ACCOUNT = identity.Account;
log('identity', `account ${ACCOUNT}, region ${REGION}`);

// 1. GitHub OIDC identity provider (idempotent).
const providerArn = `arn:aws:iam::${ACCOUNT}:oidc-provider/${PROVIDER_URL}`;
try {
  await iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: providerArn }));
  log('oidc-provider', 'already exists');
} catch (error) {
  if (error.name !== 'NoSuchEntity') die(error.message);
  await iam.send(
    new CreateOpenIDConnectProviderCommand({
      Url: `https://${PROVIDER_URL}`,
      ClientIDList: ['sts.amazonaws.com'],
      Tags: [{ Key: 'app', Value: 'careops' }],
    }),
  );
  log('oidc-provider', `created ${providerArn}`);
}

// 2. Role trust: GitHub tokens for THIS repo, main branch or workflow_dispatch.
const trustPolicy = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Federated: providerArn },
      Action: 'sts:AssumeRoleWithWebIdentity',
      Condition: {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            `repo:${REPO}:ref:refs/heads/main`,
            `repo:${REPO}:environment:*`,
          ],
        },
      },
    },
  ],
};

const roleArn = `arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}`;
try {
  await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
  await iam.send(
    new TagRoleCommand({ RoleName: ROLE_NAME, Tags: [{ Key: 'app', Value: 'careops' }] }),
  );
  log('role', `${ROLE_NAME} already exists — trust policy left as-is (update manually if needed)`);
} catch (error) {
  if (error.name !== 'NoSuchEntity') die(error.message);
  await iam.send(
    new CreateRoleCommand({
      RoleName: ROLE_NAME,
      AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
      Description: 'GitHub OIDC deploy role for CareOps (W3-T5 pipeline)',
      MaxSessionDuration: 3600,
      Tags: [{ Key: 'app', Value: 'careops' }],
    }),
  );
  log('role', `created ${roleArn}`);
}

// 3. Inline policy: exactly what build→push→deploy→smoke touches.
const policy = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'Ecr',
      Effect: 'Allow',
      Action: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:PutImage',
        'ecr:InitiateLayerUpload',
        'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload',
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
        'ecr:DescribeRepositories',
        'ecr:CreateRepository',
        'ecr:DeleteRepository',
        'ecr:ListImages',
        'ecr:BatchDeleteImage',
      ],
      Resource: '*',
    },
    { Sid: 'CloudFormation', Effect: 'Allow', Action: ['cloudformation:*'], Resource: '*' },
    { Sid: 'Ecs', Effect: 'Allow', Action: ['ecs:*', 'application-autoscaling:*'], Resource: '*' },
    {
      Sid: 'Ec2ElbNetwork',
      Effect: 'Allow',
      Action: ['ec2:*', 'elasticloadbalancing:*'],
      Resource: '*',
    },
    { Sid: 'CloudFront', Effect: 'Allow', Action: ['cloudfront:*'], Resource: '*' },
    { Sid: 'ElastiCache', Effect: 'Allow', Action: ['elasticache:*'], Resource: '*' },
    {
      Sid: 'SecretsManager',
      Effect: 'Allow',
      Action: [
        'secretsmanager:CreateSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue',
        'secretsmanager:TagResource',
        'secretsmanager:DeleteSecret',
        'secretsmanager:UpdateSecret',
      ],
      Resource: 'arn:aws:secretsmanager:*:*:secret:careops/*',
    },
    {
      Sid: 'Logs',
      Effect: 'Allow',
      Action: ['logs:*'],
      Resource: 'arn:aws:logs:*:*:log-group:/aws/careops*',
    },
    {
      Sid: 'S3CdkAssets',
      Effect: 'Allow',
      Action: ['s3:*'],
      Resource: ['arn:aws:s3:::cdk-*', 'arn:aws:s3:::cdk-*/*'],
    },
    {
      Sid: 'DynamoDbCdkLocks',
      Effect: 'Allow',
      Action: ['dynamodb:*'],
      Resource: 'arn:aws:dynamodb:*:*:table/CDKToolkit*',
    },
    {
      Sid: 'IamPassAndCdkRoles',
      Effect: 'Allow',
      Action: [
        'iam:PassRole',
        'iam:CreateRole',
        'iam:DeleteRole',
        'iam:GetRole',
        'iam:UpdateRole',
        'iam:TagRole',
        'iam:UntagRole',
        'iam:PutRolePolicy',
        'iam:DeleteRolePolicy',
        'iam:GetRolePolicy',
        'iam:ListRolePolicies',
        'iam:AttachRolePolicy',
        'iam:DetachRolePolicy',
        'iam:ListAttachedRolePolicies',
        'iam:CreateOpenIDConnectProvider',
        'iam:GetOpenIDConnectProvider',
      ],
      Resource: '*',
    },
  ],
};
await iam.send(
  new PutRolePolicyCommand({
    RoleName: ROLE_NAME,
    PolicyName: 'careops-deploy',
    PolicyDocument: JSON.stringify(policy),
  }),
);
log('policy', 'inline careops-deploy attached (scoped; widen only if deploy needs more)');

console.log(`\nrole ARN: ${roleArn}`);
const ghCommand = `gh variable set AWS_DEPLOY_ROLE_ARN --body "${roleArn}"`;
console.log(`then: ${ghCommand}`);
if (SET_GH_VAR) {
  const { execFileSync } = await import('node:child_process');
  execFileSync('gh', ['variable', 'set', 'AWS_DEPLOY_ROLE_ARN', '--body', roleArn], {
    stdio: 'inherit',
  });
  execFileSync('gh', ['variable', 'set', 'AWS_REGION', '--body', REGION], { stdio: 'inherit' });
  log('github', 'AWS_DEPLOY_ROLE_ARN + AWS_REGION set as repo variables');
  console.log('\nDone — merge to main (or run the Deploy workflow) and it ships.');
}
