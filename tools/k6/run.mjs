// k6 receipt runner (W2-T9). Orchestrates three fixed-VU runs against the booted
// API and writes the p95 receipts under tools/receipts/:
//
//   1. dashboard WARM — cache settled; cached reads hit Redis.
//   2. dashboard COLD — this runner bumps reports:gen:{org} every GEN_BUMP_MS,
//      so every cached read recomputes (ADR-0011's invalidation path). Same VUs,
//      duration, and days as WARM. The two always-live endpoints (status-breakdown,
//      today) are the control: any warm/cold shift in them is between-run drift,
//      which the summary divides out of the cached ratios (see normalization below).
//   3. appointments-list — first page + cursor-deep pages, never cached.
//
// Prerequisites (see tools/README.md): the compose stack is up, the receipts db
// is seeded + loaded (tools/load-dataset.mjs), and an isolated API is booted
// against that db. Nothing here touches the demo `careops` db or its cache keys:
// every Redis key it reads/deletes is scoped to the receipts organizationId.
//
//   bun tools/k6/run.mjs
//
// Env: BASE_URL, MONGODB_URI, REDIS_URL, VUS, DURATION, DAYS, EMAIL, PASSWORD,
// GEN_BUMP_MS. Defaults target the isolated receipts API on :3011.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { MongoClient } from '../lib/mongo.mjs';

const apiRequire = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const Redis = apiRequire('ioredis');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3011';
const MONGODB_URI =
  process.env.MONGODB_URI ?? 'mongodb://localhost:27017/careops_t9_receipts?replicaSet=rs0';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const VUS = process.env.VUS ?? '10';
const DURATION = process.env.DURATION ?? '30s';
const WARMUP_DURATION = process.env.WARMUP_DURATION ?? '10s';
const DAYS = process.env.DAYS ?? '30';
const EMAIL = process.env.EMAIL ?? 'owner@demo.careops';
const PASSWORD = process.env.PASSWORD ?? 'careops-demo-1';
const GEN_BUMP_MS = Number(process.env.GEN_BUMP_MS ?? 20);

const scriptDir = new URL('.', import.meta.url);
const receiptsDir = new URL('../receipts/', import.meta.url);
const receiptPath = (name) => fileURLToPath(new URL(`../receipts/${name}`, import.meta.url));

function runK6(script, extraEnv, duration = DURATION) {
  const args = [
    'run',
    '--quiet',
    '--env',
    `BASE_URL=${BASE_URL}`,
    '--env',
    `VUS=${VUS}`,
    '--env',
    `DURATION=${duration}`,
    '--env',
    `DAYS=${DAYS}`,
    '--env',
    `EMAIL=${EMAIL}`,
    '--env',
    `PASSWORD=${PASSWORD}`,
    ...Object.entries(extraEnv).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    fileURLToPath(new URL(script, scriptDir)),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('k6', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

// Delete only this org's report ENTRY keys (reports:{org}:*), never the gen key
// (reports:gen:{org}) and never another tenant's keys. SCAN, not KEYS, so the
// shared Redis is never blocked.
async function deleteReportEntries(redis, org) {
  const stream = redis.scanStream({ match: `reports:${org}:*`, count: 200 });
  let pipeline = redis.pipeline();
  let queued = 0;
  let deleted = 0;
  for await (const keys of stream) {
    for (const key of keys) {
      pipeline.del(key);
      queued += 1;
      deleted += 1;
      if (queued >= 200) {
        await pipeline.exec();
        pipeline = redis.pipeline();
        queued = 0;
      }
    }
  }
  if (queued > 0) await pipeline.exec();
  return deleted;
}

const readJson = (name) => JSON.parse(readFileSync(receiptPath(name), 'utf8'));
const p95 = (receipt, endpoint) => receipt.endpoints[endpoint].p95;
const round2 = (n) => Math.round(n * 100) / 100;

async function main() {
  const health = await fetch(`${BASE_URL}/api/health`).catch(() => null);
  if (!health || !health.ok) {
    throw new Error(`API not reachable at ${BASE_URL}/api/health — boot the isolated API first.`);
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const org = (
    await client
      .db()
      .collection('patient')
      .findOne({}, { projection: { organizationId: 1 } })
  ).organizationId;
  await client.close();

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  mkdirSync(receiptsDir, { recursive: true });

  console.log(`k6 receipts: org=${org} vus=${VUS} duration=${DURATION} days=${DAYS}\n`);

  // 0. WARMUP — a throwaway load pass so the API's JIT, Mongo working set, and
  // BetterAuth session lookups are hot BEFORE either measured run. Without this
  // the first measured run pays cold-start cost and the always-live control
  // endpoints drift, confounding the warm-vs-cold cache comparison.
  console.log('=== warmup (%s, discarded) ===', WARMUP_DURATION);
  await runK6('dashboard.js', { CACHE_MODE: 'warmup' }, WARMUP_DURATION);

  // 1. WARM — clean slate, cache settles during the run.
  console.log('\n=== dashboard WARM (cache settled) ===');
  await deleteReportEntries(redis, org);
  const warmCode = await runK6('dashboard.js', {
    CACHE_MODE: 'warm',
    RECEIPT_PATH: receiptPath('k6-dashboard-warm.json'),
  });
  if (warmCode !== 0) throw new Error(`warm dashboard run failed (k6 exit ${warmCode})`);

  // 2. COLD — bump the generation continuously so cached reads always recompute.
  console.log('\n=== dashboard COLD (generation bumped every %dms) ===', GEN_BUMP_MS);
  await deleteReportEntries(redis, org);
  const genKey = `reports:gen:${org}`;
  const bumper = setInterval(() => {
    redis.incr(genKey).catch(() => {});
  }, GEN_BUMP_MS);
  let coldCode;
  try {
    coldCode = await runK6('dashboard.js', {
      CACHE_MODE: 'cold',
      RECEIPT_PATH: receiptPath('k6-dashboard-cold.json'),
    });
  } finally {
    clearInterval(bumper);
    await deleteReportEntries(redis, org); // clean up orphaned cold keys
  }
  if (coldCode !== 0) throw new Error(`cold dashboard run failed (k6 exit ${coldCode})`);

  // 3. LIST — cursor pagination under load (never cached).
  console.log('\n=== appointments-list (cursor pages) ===');
  const listCode = await runK6('appointments-list.js', {
    RECEIPT_PATH: receiptPath('k6-appointments-list.json'),
  });
  if (listCode !== 0) throw new Error(`appointments-list run failed (k6 exit ${listCode})`);

  await redis.quit();

  const warm = readJson('k6-dashboard-warm.json');
  const cold = readJson('k6-dashboard-cold.json');
  const list = readJson('k6-appointments-list.json');

  const cached = ['daily-volume', 'provider-utilization'];
  const control = ['status-breakdown', 'today'];
  const delta = (endpoint) => {
    const w = p95(warm, endpoint);
    const c = p95(cold, endpoint);
    return { endpoint, warmP95: w, coldP95: c, savedMs: round2(c - w), ratio: round2(c / w) };
  };

  // WARM and COLD are separate k6 invocations, so between-run drift (Mongo/OS
  // cache warming, order effects) shifts EVERY endpoint, not just the cached
  // ones. The two always-live controls measure that drift directly: their
  // cold/warm ratio is the run-to-run factor with no cache effect in it. Divide
  // it out of the cached ratios to recover the under-load cache signal. The
  // controlled bench (tools/bench-cache.mjs) is the confound-free headline; this
  // normalization makes the under-load number defensible rather than raw.
  const controlDeltas = control.map(delta);
  const driftFactor = round2(
    Math.exp(controlDeltas.reduce((sum, d) => sum + Math.log(d.ratio), 0) / controlDeltas.length),
  );
  const cachedDeltas = cached.map((endpoint) => {
    const d = delta(endpoint);
    return { ...d, normalizedRatio: round2(d.ratio / driftFactor) };
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    organizationId: org,
    vus: Number(VUS),
    duration: DURATION,
    days: Number(DAYS),
    genBumpMs: GEN_BUMP_MS,
    cachedEndpoints: cachedDeltas,
    controlEndpoints: controlDeltas,
    controlDriftFactor: driftFactor,
    normalization:
      "normalizedRatio = (coldP95/warmP95) / controlDriftFactor; controlDriftFactor is the geometric mean of the always-live controls' cold/warm ratios (between-run drift, no cache effect). See tools/bench-cache.mjs for the controlled per-request delta.",
    list: { firstPageP95: list.firstPage.p95, deepPageP95: list.deepPage.p95 },
  };
  writeFileSync(receiptPath('k6-summary.json'), JSON.stringify(summary, null, 2) + '\n');

  console.log('\n=== p95 cache delta (warm vs cold, same load) ===');
  for (const d of summary.cachedEndpoints) {
    console.log(
      `  ${d.endpoint.padEnd(22)} warm=${String(d.warmP95).padStart(7)}ms  cold=${String(d.coldP95).padStart(7)}ms  raw=${d.ratio}x  normalized=${d.normalizedRatio}x`,
    );
  }
  console.log(`  control drift factor (cold/warm, always-live): ${driftFactor}x`);
  for (const d of summary.controlEndpoints) {
    console.log(
      `  ${d.endpoint.padEnd(22)} warm=${String(d.warmP95).padStart(7)}ms  cold=${String(d.coldP95).padStart(7)}ms  (${d.ratio}x)`,
    );
  }
  console.log(
    `  appointments-list      first=${list.firstPage.p95}ms  deep=${list.deepPage.p95}ms (p95)`,
  );
  console.log('\nWrote', receiptPath('k6-summary.json'));
}

main()
  .catch((error) => {
    console.error('k6 runner failed:', error.message);
    process.exitCode = 1;
  })
  .then(() => process.exit(process.exitCode ?? 0));
