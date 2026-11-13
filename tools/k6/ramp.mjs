// k6 horizontal-scaling ramp (W3-T3). Measures ONE replica stage per invocation
// against the ALB and records it in the ramp receipt; `--report` merges all
// recorded stages and validates the scaling claim (aggregate throughput rises
// with replicas, zero failures). The dashboard scenario (W2-T9) is reused
// unchanged: 4 report reads per iteration, warm cache.
//
//   cdk deploy -c minCapacity=1 ...   && bun tools/k6/ramp.mjs --stage 1
//   cdk deploy -c minCapacity=2 ...   && bun tools/k6/ramp.mjs --stage 2
//   cdk deploy -c minCapacity=4 ...   && bun tools/k6/ramp.mjs --stage 4
//   bun tools/k6/ramp.mjs --report
//
// (minCapacity pins the auto-scaling floor, so a stage holds exactly N replicas
// — scale-in stops at min. See infra/README.md.)
//
// Before measuring, the runner describes the ECS service and fails if fewer
// replicas are RUNNING than the stage claims — the receipt then states
// "N replicas, measured", not "N replicas, configured". The same ECS API works
// against AWS and the Floci emulator.
//
// Env: BASE_URL (ALB DNS or Floci LB), VUS, DURATION, DAYS, EMAIL, PASSWORD,
// AWS_ENDPOINT_URL (Floci: http://localhost:4566), AWS_DEFAULT_REGION,
// CAREOPS_CLUSTER, CAREOPS_SERVICE_MATCH, RECEIPT (default k6-ramp.json).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const infraRequire = createRequire(new URL('../../infra/package.json', import.meta.url));
const { ECSClient, DescribeServicesCommand, ListServicesCommand } =
  infraRequire('@aws-sdk/client-ecs');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const VUS = Number(process.env.VUS ?? 30);
const DURATION = process.env.DURATION ?? '60s';
const DAYS = process.env.DAYS ?? '30';
const EMAIL = process.env.EMAIL ?? 'owner@demo.careops';
const PASSWORD = process.env.PASSWORD ?? 'careops-demo-1';
const ENDPOINT = process.env.AWS_ENDPOINT_URL;
const REGION = process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const CLUSTER = process.env.CAREOPS_CLUSTER ?? 'careops';
const SERVICE_MATCH = process.env.CAREOPS_SERVICE_MATCH ?? 'ApiService';
const receiptPath = (name) => fileURLToPath(new URL(`../receipts/${name}`, import.meta.url));
const RECEIPT_FILE = process.env.RECEIPT ?? 'k6-ramp.json';
const RECEIPTS_DIR = fileURLToPath(new URL('../receipts/', import.meta.url));

// -------- receipt helpers ----------------------------------------------------

function readRampReceipt() {
  const path = receiptPath(RECEIPT_FILE);
  if (!existsSync(path)) return { stages: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return { ...parsed, stages: Array.isArray(parsed.stages) ? parsed.stages : [] };
}

function writeRampReceipt(receipt) {
  writeFileSync(receiptPath(RECEIPT_FILE), JSON.stringify(receipt, null, 2) + '\n');
}

// -------- ECS: measure, not assume, the replica count ------------------------

async function describeRunningCount() {
  const config = {
    region: REGION,
    ...(ENDPOINT
      ? { endpoint: ENDPOINT, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }
      : {}),
  };
  const client = new ECSClient(config);
  const { serviceArns } = await client.send(new ListServicesCommand({ cluster: CLUSTER }));
  if (!serviceArns?.length) throw new Error(`no ECS services in cluster ${CLUSTER}`);
  const { services } = await client.send(
    new DescribeServicesCommand({ cluster: CLUSTER, services: serviceArns }),
  );
  const matches = (services ?? []).filter((s) => s.serviceName?.includes(SERVICE_MATCH));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ECS service matching "${SERVICE_MATCH}", found ${matches.length}`,
    );
  }
  const service = matches[0];
  return {
    running: service.runningCount ?? 0,
    desired: service.desiredCount ?? 0,
    serviceName: service.serviceName,
  };
}

// -------- k6: one warm dashboard run -----------------------------------------

function runK6(stageReceiptPath) {
  const script = fileURLToPath(new URL('dashboard.js', import.meta.url));
  const args = [
    'run',
    '--quiet',
    '--env',
    `BASE_URL=${BASE_URL}`,
    '--env',
    `VUS=${VUS}`,
    '--env',
    `DURATION=${DURATION}`,
    '--env',
    `DAYS=${DAYS}`,
    '--env',
    `EMAIL=${EMAIL}`,
    '--env',
    `PASSWORD=${PASSWORD}`,
    '--env',
    'CACHE_MODE=warm',
    '--env',
    `RECEIPT_PATH=${stageReceiptPath}`,
    script,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('k6', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`k6 exit ${code}`))));
  });
}

// -------- commands -----------------------------------------------------------

async function measure(stage) {
  const health = await fetch(`${BASE_URL}/api/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(
      `API not reachable at ${BASE_URL}/api/health — point BASE_URL at the ALB (or Floci LB).`,
    );
  }

  const { running, desired, serviceName } = await describeRunningCount();
  if (running < stage) {
    throw new Error(
      `stage ${stage} claims ${stage} replicas but only ${running}/${desired} are RUNNING ` +
        `(${serviceName}) — redeploy with -c minCapacity=${stage} and wait for steady state`,
    );
  }
  if (running > stage) {
    console.warn(
      `warning: ${running} replicas running, stage claims ${stage} (auto-scaling may have scaled out under prior load)`,
    );
  }

  const stageReceiptPath = receiptPath(`.ramp-stage.json`);
  await runK6(stageReceiptPath);
  const run = JSON.parse(readFileSync(stageReceiptPath, 'utf8'));

  const durationSeconds = parseDurationSeconds(DURATION);
  const readsPerSec = round2(((run.iterations ?? 0) * 4) / durationSeconds);
  const entry = {
    stage,
    replicasMeasured: running,
    serviceName,
    baseUrl: BASE_URL,
    vus: VUS,
    duration: DURATION,
    iterations: run.iterations ?? null,
    readsPerSec,
    p95: run.httpReqDurationP95 ?? null,
    failures: run.failures ?? 0,
    measuredAt: run.generatedAt,
  };

  const receipt = readRampReceipt();
  // Re-measuring a stage replaces its previous entry (idempotent by stage).
  receipt.stages = [...receipt.stages.filter((s) => s.stage !== stage), entry].sort(
    (a, b) => a.stage - b.stage,
  );
  receipt.meta = { scenario: 'dashboard warm', readsPerIteration: 4, updatedAt: entry.measuredAt };
  writeRampReceipt(receipt);

  console.log(
    `\nstage ${stage}: ${running} replica(s), ${readsPerSec} reads/s, p95=${entry.p95}ms, failures=${entry.failures}`,
  );
  console.log(`recorded -> ${receiptPath(RECEIPT_FILE)}`);
}

function report() {
  const { stages } = readRampReceipt();
  if (stages.length < 2) {
    throw new Error(`need at least 2 recorded stages in ${RECEIPT_FILE}, have ${stages.length}`);
  }
  const rows = stages.map((s) => ({
    ...s,
    p95VsPrev: s.p95 == null ? null : round2(s.p95),
  }));

  console.log('=== k6 replica ramp (aggregate reads/s, dashboard warm) ===');
  for (const [i, row] of rows.entries()) {
    const prev = rows[i - 1];
    const lift =
      prev && prev.readsPerSec
        ? ` (${round2(row.readsPerSec / prev.readsPerSec)}x vs stage ${prev.stage})`
        : '';
    console.log(
      `  stage ${row.stage}: replicas=${row.replicasMeasured}  reads/s=${row.readsPerSec}${lift}  p95=${row.p95}ms  failures=${row.failures}`,
    );
  }

  const problems = [];
  for (const row of rows) {
    if (row.replicasMeasured !== row.stage) {
      problems.push(
        `stage ${row.stage} measured ${row.replicasMeasured} replicas, not ${row.stage}`,
      );
    }
    if ((row.failures ?? 0) !== 0) problems.push(`stage ${row.stage} had ${row.failures} failures`);
  }
  for (const [i, row] of rows.entries()) {
    if (i === 0) continue;
    if (!(row.readsPerSec > rows[i - 1].readsPerSec)) {
      problems.push(
        `stage ${row.stage} reads/s (${row.readsPerSec}) did not rise above stage ${rows[i - 1].stage} (${rows[i - 1].readsPerSec})`,
      );
    }
  }

  if (problems.length) {
    console.error('\nramp FAILED the scaling claim:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    const receipt = readRampReceipt();
    receipt.verdict = {
      scaling: 'aggregate throughput rose with every added replica',
      failures: 0,
      verifiedAt: new Date().toISOString(),
    };
    writeRampReceipt(receipt);
    console.log('\nramp OK: throughput rose 1→2→4 with zero failures.');
  }
}

function parseDurationSeconds(duration) {
  const match = /^(\d+)(ms|s|m)$/.exec(duration);
  if (!match) throw new Error(`cannot parse DURATION "${duration}"`);
  const [, n, unit] = match;
  return Number(n) * (unit === 'ms' ? 0.001 : unit === 's' ? 1 : 60);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// -------- entry ---------------------------------------------------------------

const stageFlag = process.argv.indexOf('--stage');
if (stageFlag !== -1) {
  const stage = Number(process.argv[stageFlag + 1]);
  if (!Number.isInteger(stage) || stage < 1) {
    console.error('usage: k6/ramp.mjs --stage <N> | --report');
    process.exit(2);
  }
  measure(stage).catch((error) => {
    console.error('ramp stage failed:', error.message);
    process.exitCode = 1;
  });
} else if (process.argv.includes('--report')) {
  try {
    report();
  } catch (error) {
    console.error('ramp report failed:', error.message);
    process.exitCode = 1;
  }
} else {
  console.error('usage: k6/ramp.mjs --stage <N> | --report');
  process.exit(2);
}
