#!/usr/bin/env node
// Floci deploy proof (ADR-0012, W3-T2). Two steps the CDK deploy leaves to the
// operator: populate the runtime secrets, then verify the API service reaches
// steady state with a green /api/health. Run from infra/ after `cdk deploy`.
//
//   node scripts/floci-proof.mjs secrets   # put Mongo/SMTP/auth secret values
//   node scripts/floci-proof.mjs verify    # wait for steady + probe health
//
// Floci ECS tasks are real Docker containers on Floci's network, so the compose
// data plane is reached via host.docker.internal and health is probed inside the
// task (Floci's ALB is metadata-only and does not proxy).

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { SecretsManagerClient, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  ECSClient,
  DescribeServicesCommand,
  DescribeTasksCommand,
  ListServicesCommand,
  ListTasksCommand,
} from '@aws-sdk/client-ecs';

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const REGION = process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const CLUSTER = process.env.CAREOPS_CLUSTER ?? 'careops';
// Physical ECS service names embed the CDK logical id ('ApiService'). Match on
// that rather than trusting list order — W3-T4 adds a second service.
const SERVICE_MATCH = process.env.CAREOPS_SERVICE_MATCH ?? 'ApiService';
const DATA_HOST = process.env.CAREOPS_DATA_HOST ?? 'host.docker.internal';
const API_PORT = Number(process.env.CAREOPS_API_PORT ?? 3001);
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
};
const config = { endpoint: ENDPOINT, region: REGION, credentials };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function populateSecrets() {
  const client = new SecretsManagerClient(config);
  // Local compose endpoints carry no credentials; the auth secret is generated
  // here so no secret value is ever committed.
  const values = {
    'careops/mongodb-uri': `mongodb://${DATA_HOST}:27017/careops?directConnection=true`,
    'careops/smtp-url': `smtp://${DATA_HOST}:1025`,
    'careops/better-auth-secret': randomBytes(32).toString('hex'),
  };
  for (const [name, value] of Object.entries(values)) {
    const result = await client.send(
      new PutSecretValueCommand({ SecretId: name, SecretString: value }),
    );
    console.log(`populated ${name} (version ${result.VersionId}, ${value.length} chars)`);
  }
}

async function findService(client) {
  const { serviceArns } = await client.send(new ListServicesCommand({ cluster: CLUSTER }));
  if (!serviceArns?.length) throw new Error(`no ECS services in cluster ${CLUSTER}`);
  const { services } = await client.send(
    new DescribeServicesCommand({ cluster: CLUSTER, services: serviceArns }),
  );
  const matches = (services ?? []).filter((s) => s.serviceName?.includes(SERVICE_MATCH));
  if (matches.length === 0) {
    throw new Error(`no ECS service matching "${SERVICE_MATCH}" in cluster ${CLUSTER}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} ECS services match "${SERVICE_MATCH}" — narrow it with CAREOPS_SERVICE_MATCH`,
    );
  }
  return matches[0];
}

async function waitForSteady(client, serviceName) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const { services } = await client.send(
      new DescribeServicesCommand({ cluster: CLUSTER, services: [serviceName] }),
    );
    const service = services?.[0];
    const deployment = service?.deployments?.[0];
    const steady =
      service?.runningCount === service?.desiredCount &&
      service?.pendingCount === 0 &&
      service?.deployments?.length === 1 &&
      deployment?.rolloutState === 'COMPLETED';
    if (steady) {
      console.log(
        `steady: desired=${service.desiredCount} running=${service.runningCount} rollout=${deployment.rolloutState}`,
      );
      return service;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `service not steady after 120s (running=${service?.runningCount}/${service?.desiredCount})`,
      );
    }
    await sleep(3000);
  }
}

async function probeHealth(client, serviceName) {
  const { taskArns } = await client.send(new ListTasksCommand({ cluster: CLUSTER, serviceName }));
  if (!taskArns?.length) throw new Error('no running tasks');
  const { tasks } = await client.send(
    new DescribeTasksCommand({ cluster: CLUSTER, tasks: taskArns }),
  );
  const task = tasks?.[0];
  const container = task?.containers?.[0];
  if (task?.lastStatus !== 'RUNNING' || !container?.runtimeId) {
    throw new Error(
      `task not running (lastStatus=${task?.lastStatus}, stoppedReason=${task?.stoppedReason ?? '-'})`,
    );
  }
  const probe = `fetch('http://127.0.0.1:${API_PORT}/api/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{process.stderr.write(String(e));process.exit(1)})`;
  const body = execFileSync('docker', ['exec', container.runtimeId, 'node', '-e', probe], {
    encoding: 'utf8',
  });
  const health = JSON.parse(body);
  if (health.status !== 'ok' || health.mongo !== 'up' || health.redis !== 'up') {
    throw new Error(`health not green: ${body}`);
  }
  console.log(`health: ${body.trim()}`);
}

async function verify() {
  const client = new ECSClient(config);
  const service = await findService(client);
  console.log(`service: ${service.serviceName}`);
  await waitForSteady(client, service.serviceName);
  await probeHealth(client, service.serviceName);
  console.log(
    'Floci proof OK: one API replica steady with green /api/health on compose Mongo/Redis.',
  );
}

const command = process.argv[2];
try {
  if (command === 'secrets') await populateSecrets();
  else if (command === 'verify') await verify();
  else {
    console.error('usage: node scripts/floci-proof.mjs <secrets|verify>');
    process.exit(2);
  }
} catch (error) {
  console.error(`Floci proof FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
