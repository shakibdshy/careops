// Cache receipt (W2-T9): the report cache's before/after latency, measured
// CONTROLLED — one session, no concurrent load, alternating invalidation and
// settled reads of the SAME endpoint. This isolates the cache effect from the
// system-level drift that a between-run k6 comparison picks up (the k6 scenarios
// measure under-load p95; this measures the per-request cache delta).
//
//   bun tools/load-dataset.mjs        # once, against the receipts db
//   bun tools/bench-cache.mjs         # isolated API booted against that db
//
// For each endpoint it bumps reports:gen:{org} (ADR-0011 invalidation), times
// the first read (a MISS for the cached endpoints — recompute), then times an
// immediate second read (a HIT — served from Redis). The two always-live
// endpoints (status-breakdown, today) are the control: the generation bump does
// not touch them, so their miss/hit timings should be ~equal.
//
// Reports median AND p95 over N samples. Throws away a few warm-up samples so
// connection/JIT cold-start does not skew the tail.

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { MongoClient } from './lib/mongo.mjs';

const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const Redis = apiRequire('ioredis');

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3011';
const MONGODB_URI =
  process.env.MONGODB_URI ?? 'mongodb://localhost:27017/careops_t9_receipts?replicaSet=rs0';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const EMAIL = process.env.EMAIL ?? 'owner@demo.careops';
const PASSWORD = process.env.PASSWORD ?? 'careops-demo-1';
const DAYS = Number(process.env.DAYS ?? 30);
const SAMPLES = Number(process.env.RECEIPTS_CACHE_SAMPLES ?? 20);
const WARMUP = 3;

const ENDPOINTS = [
  { name: 'daily-volume', cached: true },
  { name: 'provider-utilization', cached: true },
  { name: 'status-breakdown', cached: false },
  { name: 'today', cached: false },
];

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (n) => Math.round(n * 100) / 100;
  return {
    samples: sorted.length,
    median: round(at(0.5)),
    p95: round(at(0.95)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  };
}

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
  const genKey = `reports:gen:${org}`;

  const signin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (signin.status !== 200) throw new Error(`sign-in failed (${signin.status})`);
  const cookie = signin.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  const timeGet = async (path) => {
    const t0 = performance.now();
    const res = await fetch(`${BASE_URL}${path}`, { headers: { Cookie: cookie } });
    await res.text();
    if (res.status !== 200) throw new Error(`${path} -> ${res.status}`);
    return performance.now() - t0;
  };

  const results = {};
  for (const { name, cached } of ENDPOINTS) {
    const path = name === 'today' ? '/api/reports/today' : `/api/reports/${name}?days=${DAYS}`;
    const miss = [];
    const hit = [];
    for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
      await redis.incr(genKey); // invalidate: next cached read recomputes
      const m = await timeGet(path);
      const h = await timeGet(path); // same generation: cached read hits Redis
      if (i >= WARMUP) {
        miss.push(m);
        hit.push(h);
      }
    }
    results[name] = {
      cached,
      afterInvalidation: stats(miss),
      settled: stats(hit),
      savedMedianMs: Math.round((stats(miss).median - stats(hit).median) * 100) / 100,
      speedupMedian: Math.round((stats(miss).median / stats(hit).median) * 100) / 100,
    };
  }

  // Leave the receipts org's cache clean (entries only; the gen key is harmless).
  const stream = redis.scanStream({ match: `reports:${org}:*`, count: 200 });
  for await (const keys of stream) {
    if (keys.length) await redis.del(...keys);
  }
  await redis.quit();

  const receipt = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    organizationId: org,
    days: DAYS,
    samplesPerEndpoint: SAMPLES,
    method:
      'controlled, single session, no concurrent load; alternating gen-bump miss / settled hit',
    endpoints: results,
  };
  mkdirSync(new URL('./receipts/', import.meta.url), { recursive: true });
  const outPath = new URL('./receipts/cache-miss-hit.json', import.meta.url);
  writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n');

  console.log('Cache receipt (controlled miss vs hit, %d samples, days=%d):', SAMPLES, DAYS);
  for (const [name, r] of Object.entries(results)) {
    const tag = r.cached ? 'cached' : 'live (control)';
    console.log(
      `  ${name.padEnd(22)} [${tag.padEnd(14)}] miss p95=${String(r.afterInvalidation.p95).padStart(7)}ms med=${String(r.afterInvalidation.median).padStart(6)}ms  ->  hit p95=${String(r.settled.p95).padStart(7)}ms med=${String(r.settled.median).padStart(6)}ms  (${r.speedupMedian}x median)`,
    );
  }
  console.log('Wrote', outPath.pathname);
}

main()
  .catch((error) => {
    console.error('bench-cache failed:', error.message);
    process.exitCode = 1;
  })
  .then(() => process.exit(process.exitCode ?? 0));
