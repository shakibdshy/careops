// Cross-replica freshness proof (W3-T3, ADR-0011). Boots TWO API replicas
// against the shared compose data plane (Mongo + Redis), books an appointment
// through replica A, and asserts the very next report read served by replica B
// already includes it. No replica-local cache can hide the booking: every
// Appointment write INCRs the org's generation counter in the SHARED Redis
// (post-commit), so B's next cached read recomputes under the new generation.
//
//   bun tools/prove-replica-freshness.mjs
//
// Prerequisites: compose data plane up (`docker compose up -d --wait`), demo db
// seeded (`bun run seed`), API built (dist present — `bun run build`).
//
// Documented exception to the tools/ throwaway-db rule: the proof needs the
// SEEDED demo org (users/members/patients), so it books exactly one appointment
// into the dev `careops` db and bumps its generation counter once. Nothing is
// deleted; point MONGODB_URI at a throwaway seeded db if that matters.
//
// Env: MONGODB_URI, REDIS_URL (defaults follow .env.example), REPLICAS_A_PORT /
// REPLICAS_B_PORT (3012/3013), EMAIL, PASSWORD.
//
// On PASS writes tools/receipts/cross-replica-freshness.json — the receipt
// docs/scaling.md cites for the multi-replica freshness claim.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MongoClient } from './lib/mongo.mjs';

const apiRequire = createRequire(new URL('../apps/api/package.json', import.meta.url));
const Redis = apiRequire('ioredis');

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/careops?replicaSet=rs0';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const PORT_A = process.env.REPLICAS_A_PORT ?? '3012';
const PORT_B = process.env.REPLICAS_B_PORT ?? '3013';
const EMAIL = process.env.EMAIL ?? 'owner@demo.careops';
const PASSWORD = process.env.PASSWORD ?? 'careops-demo-1';
const BASE_A = `http://localhost:${PORT_A}`;
const BASE_B = `http://localhost:${PORT_B}`;
const RECEIPT_PATH = fileURLToPath(
  new URL('../tools/receipts/cross-replica-freshness.json', import.meta.url),
);

const log = (step, detail = '') => console.log(`  [${step}] ${detail}`);
const fail = (step, detail) => {
  console.error(`  ✗ [${step}] ${detail}`);
  process.exitCode = 1;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolve the demo org through the signed-in user: user -> member -> org ->
// another member as the provider -> a patient of that org. Existing appointment
// rows are NOT a reliable id source (seed re-runs recreate members, leaving old
// rows pointing at replaced ids), but the live auth chain always is.
async function resolveDemoData(db) {
  const user = await db.collection('user').findOne({ email: EMAIL });
  if (!user) throw new Error(`no user ${EMAIL} — run \`bun run seed\` first.`);
  const ownerMembership = await db.collection('member').findOne({ userId: user._id });
  if (!ownerMembership) throw new Error(`user ${EMAIL} has no organization membership.`);
  const org = ownerMembership.organizationId;
  const providerMember = await db.collection('member').findOne({
    organizationId: org,
    _id: { $ne: ownerMembership._id },
  });
  if (!providerMember) throw new Error('demo org has no second member to act as provider.');
  // patient rows store organizationId as a hex string; member rows as ObjectId.
  const patient = await db.collection('patient').findOne({ organizationId: String(org) });
  if (!patient) throw new Error('demo org has no patients.');
  return {
    org: String(org),
    memberId: String(providerMember._id),
    patientId: String(patient._id),
  };
}

async function waitHealthy(base, label, deadlineMs = 90_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const res = await fetch(`${base}/api/health`).catch(() => null);
    if (res?.ok) {
      const body = await res.json().catch(() => null);
      if (body?.status === 'ok' && body?.mongo === 'up' && body?.redis === 'up') {
        log('health', `${label} green on ${base} (mongo up, redis up)`);
        return body;
      }
    }
    if (Date.now() > deadline)
      throw new Error(`${label} not healthy at ${base} after ${deadlineMs / 1000}s`);
    await sleep(1000);
  }
}

// Pick a start inside the trailing report window (so daily-volume sees it) that
// does not overlap the template provider's schedule — walk forward until free.
async function pickFreeStart(db, memberId) {
  const base = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  base.setUTCHours(3, 17, 0, 0); // 03:17 UTC — off-business-hours, minimal collision odds
  const durationMs = 30 * 60 * 1000;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const start = new Date(base.getTime() + attempt * 7 * 60 * 1000);
    const end = new Date(start.getTime() + durationMs);
    const conflicts = await db.collection('appointment').countDocuments({
      memberId,
      start: { $lt: end },
      end: { $gt: start },
    });
    if (conflicts === 0) return start;
  }
  throw new Error('no conflict-free slot found near 2 days ago');
}

async function main() {
  const distMain = new URL('../apps/api/dist/main.js', import.meta.url);
  if (!existsSync(distMain)) {
    throw new Error('apps/api/dist/main.js missing — run `bun run build` first.');
  }
  if (!existsSync(new URL('../apps/api/.env', import.meta.url))) {
    copyFileSync(
      new URL('../.env.example', import.meta.url),
      new URL('../apps/api/.env', import.meta.url),
    );
    log('env', 'copied .env.example -> apps/api/.env');
  }

  const mongo = new MongoClient(MONGODB_URI);
  await mongo.connect();
  const db = mongo.db();

  const demo = await resolveDemoData(db);
  const org = demo.org;

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const genKey = `reports:gen:${org}`;

  // Boot both replicas from the SAME image/dist against the SAME shared data
  // plane; only the port differs. dotenv loads apps/api/.env from the cwd.
  const spawnReplica = (port) =>
    spawn('node', ['dist/main.js'], {
      cwd: fileURLToPath(new URL('../apps/api', import.meta.url)),
      env: { ...process.env, PORT: port, MONGODB_URI, REDIS_URL },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  const replicas = [
    { label: 'replica-A', base: BASE_A, child: spawnReplica(PORT_A) },
    { label: 'replica-B', base: BASE_B, child: spawnReplica(PORT_B) },
  ];
  for (const replica of replicas) {
    replica.child.stderr.on('data', (chunk) => process.stderr.write(`${replica.label}: ${chunk}`));
  }

  try {
    const startedAt = new Date().toISOString();
    log('boot', `two replicas of the same image: A=${BASE_A} B=${BASE_B}, shared Mongo + Redis`);

    await waitHealthy(BASE_A, 'replica-A');
    await waitHealthy(BASE_B, 'replica-B');

    // Sign in on A only. Sessions live in Mongo (ADR-0007), so the cookie must
    // be accepted by B too — the same shared-store property scaling relies on.
    const signIn = await fetch(`${BASE_A}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (signIn.status !== 200) throw new Error(`sign-in failed (${signIn.status})`);
    // Node fetch (undici) exposes cookies as Set-Cookie headers, not a map.
    const cookieHeader = signIn.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    log('auth', 'signed in via replica-A (session row written to shared Mongo)');

    const sharedSession = await fetch(`${BASE_B}/api/reports/today`, {
      headers: { Cookie: cookieHeader },
    });
    if (sharedSession.status !== 200) {
      throw new Error(
        `replica-B rejected replica-A's session cookie (${sharedSession.status}) — session store not shared?`,
      );
    }
    log('session', "replica-B accepted replica-A's cookie (shared session store, ADR-0007)");

    // Baseline: B's daily-volume read, warm cache at generation g0.
    const genBefore = (await redis.get(genKey)) ?? '0';
    const volRes0 = await fetch(`${BASE_B}/api/reports/daily-volume?days=30`, {
      headers: { Cookie: cookieHeader },
    });
    if (volRes0.status !== 200) throw new Error(`daily-volume read failed (${volRes0.status})`);
    const before = await volRes0.json();
    const totalBefore = before.points.reduce((sum, point) => sum + point.count, 0);
    log(
      'baseline',
      `B serves daily-volume from cache at gen ${genBefore}: ${totalBefore} appointments in trailing 30d`,
    );

    // Book through replica A.
    const start = await pickFreeStart(db, demo.memberId);
    const book = await fetch(`${BASE_A}/api/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({
        patientId: demo.patientId,
        memberId: demo.memberId,
        start: start.toISOString(),
        durationMinutes: 30,
        notes: 'cross-replica freshness proof (W3-T3)',
      }),
    });
    if (book.status !== 201 && book.status !== 200) {
      throw new Error(`booking via replica-A failed (${book.status}): ${await book.text()}`);
    }
    log('book', `booked via replica-A: ${start.toISOString().slice(0, 16)}Z (30min)`);

    // The write path INCRs the shared generation counter (post-commit).
    const genAfter = (await redis.get(genKey)) ?? '0';
    if (Number(genAfter) <= Number(genBefore)) {
      throw new Error(
        `generation did not advance (${genBefore} -> ${genAfter}) — ADR-0011 bump missing`,
      );
    }
    log(
      'invalidate',
      `generation ${genBefore} -> ${genAfter} (shared Redis INCR from replica-A's write)`,
    );

    // B's next read must reflect the booking: new generation -> new key -> recompute.
    const volRes1 = await fetch(`${BASE_B}/api/reports/daily-volume?days=30`, {
      headers: { Cookie: cookieHeader },
    });
    if (volRes1.status !== 200) throw new Error(`post-booking read failed (${volRes1.status})`);
    const after = await volRes1.json();
    const bookedDay = start.toISOString().slice(0, 10);
    const bucketBefore = before.points.find((p) => p.date === bookedDay)?.count ?? 0;
    const bucketAfter = after.points.find((p) => p.date === bookedDay)?.count ?? 0;
    const totalAfter = after.points.reduce((sum, point) => sum + point.count, 0);

    if (bucketAfter !== bucketBefore + 1) {
      throw new Error(
        `stale read: replica-B reported ${bookedDay}=${bucketAfter} (expected ${bucketBefore + 1}) — booking invisible across replicas`,
      );
    }
    log(
      'verify',
      `replica-B now reports ${bookedDay}: ${bucketBefore} -> ${bucketAfter} (total ${totalBefore} -> ${totalAfter})`,
    );

    writeFileSync(
      RECEIPT_PATH,
      JSON.stringify(
        {
          scenario: 'cross-replica-freshness',
          generatedAt: startedAt,
          replicas: {
            bookingReplica: BASE_A,
            readReplica: BASE_B,
            sharedStores: { mongo: MONGODB_URI, redis: REDIS_URL },
          },
          mechanism:
            'post-commit generation INCR in shared Redis; B recomputes under the new generation (ADR-0011)',
          generation: { before: Number(genBefore), after: Number(genAfter) },
          dailyVolume30d: {
            bookedDay,
            before: bucketBefore,
            after: bucketAfter,
            totalBefore,
            totalAfter,
          },
          verdict: 'booking on replica A visible in the next report read served by replica B',
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      `\nPASS: booking on ${BASE_A} visible in the next report read served by ${BASE_B}.`,
    );
    console.log(`receipt -> ${RECEIPT_PATH}`);
  } finally {
    for (const replica of replicas) replica.child.kill('SIGTERM');
    redis.quit();
    await mongo.close();
  }
}

main().catch((error) => {
  fail('proof', error.message);
  process.exit(process.exitCode ?? 1);
});
