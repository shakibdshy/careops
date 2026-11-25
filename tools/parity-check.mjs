#!/usr/bin/env node
// Demo-seed parity check (Go-T18): asserts both backends hold the same demo
// dataset — the same demo Members (roles from the org surface), the same four
// demo Patients (names + birth dates), and the same Appointment clinic week
// (same total, same per-status distribution) — by signing in on each origin
// with the documented demo credentials and reading only through the API.
//
//   NESTJS_URL=http://localhost:3101 GO_URL=http://localhost:3102 bun tools/parity-check.mjs
//
// Seeds are applied first by their own commands (bun run seed / go run ./cmd/seed).
// Per-day buckets are reported but not compared: each seed anchors its clinic
// week on its own seed day, and development databases carry leftover fixture
// bookings — the seed-named Patients and the Appointment totals/statuses are
// the date-independent contract. For the full clean proof, run both seeds on
// fresh databases and point NESTJS_URL/GO_URL at those origins.

const ORIGINS = [
  { name: 'NestJS · MongoDB', url: process.env.NESTJS_URL ?? 'http://localhost:3101' },
  { name: 'Go · PostgreSQL', url: process.env.GO_URL ?? 'http://localhost:3102' },
];
const CREDENTIALS = { email: 'owner@demo.careops', password: 'careops-demo-1' };

// The four demo Patients both seeds create (apps/api/src/seed.ts and
// apps/api-go/cmd/seed).
const SEED_PATIENT_NAMES = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson'];

const failures = [];
let baseline = null;

// Order-insensitive deep comparison: the backends emit their maps in
// different key orders (Mongo cursor vs Postgres scan), which must not read
// as a difference.
const sortDeep = (value) => {
  if (Array.isArray(value))
    return value.map(sortDeep).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortDeep(value[key])]),
    );
  }
  return value;
};

for (const origin of ORIGINS) {
  const signIn = await fetch(`${origin.url}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify(CREDENTIALS),
  });
  if (signIn.status !== 200) {
    failures.push(`${origin.name}: demo owner sign-in failed (${signIn.status})`);
    continue;
  }
  const cookie = signIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
  const headers = { cookie };

  const me = await (await fetch(`${origin.url}/api/workspace/me`, { headers })).json();
  const org = await (await fetch(`${origin.url}/api/organizations/current`, { headers })).json();

  // Follow every Patients page, keeping the demo-named Patients (name →
  // dateOfBirth) and the fixture-named set (dev-database pollution tolerated).
  const patientByName = new Map();
  const patientNames = new Set();
  let cursor = '';
  for (;;) {
    const page = await (
      await fetch(`${origin.url}/api/patients?limit=100${cursor ? `&cursor=${cursor}` : ''}`, {
        headers,
      })
    ).json();
    for (const p of page.items ?? []) {
      const name = `${p.firstName} ${p.lastName}`;
      patientByName.set(name, p.dateOfBirth);
      patientNames.add(name);
    }
    if (!page.nextCursor || !page.hasMore) break;
    cursor = page.nextCursor;
  }

  // Follow every Appointments page for the total + per-status distribution.
  const statusCounts = {};
  let appointmentTotal = 0;
  cursor = '';
  for (;;) {
    const page = await (
      await fetch(`${origin.url}/api/appointments?limit=100${cursor ? `&cursor=${cursor}` : ''}`, {
        headers,
      })
    ).json();
    for (const a of page.items ?? []) {
      appointmentTotal += 1;
      statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
    }
    if (!page.nextCursor || !page.hasMore) break;
    cursor = page.nextCursor;
  }

  // The today report is time-sensitive (it counts appointments inside the
  // current UTC day, and fixture slots land wherever the loader put them),
  // so it is reported but not compared.
  const today = await (await fetch(`${origin.url}/api/reports/today`, { headers })).json();

  const seedPatients = Object.fromEntries(
    SEED_PATIENT_NAMES.filter((name) => patientByName.has(name)).map((name) => [
      name,
      patientByName.get(name),
    ]),
  );
  const snapshot = {
    orgName: me.organization.name,
    role: me.organization.role,
    members: org.members.map((m) => `${m.role}:${m.email}`).sort(),
    // The seed contract: the four demo Patients (name → dateOfBirth) and the
    // Appointment totals/statuses. Fixture-named Patients are compared as a
    // set only — both dev orgs may carry leftover bookings from earlier runs.
    seedPatients,
    appointmentTotal,
    statusCounts,
    fixturePatients: [...patientNames].filter((n) => n.startsWith('Fix-cmp-')).sort(),
  };

  console.log(`\n${origin.name} (${origin.url})`);
  console.log(
    `  org: ${snapshot.orgName} — ${snapshot.members.length} members, ${Object.keys(seedPatients).length}/4 seed Patients, ${appointmentTotal} appointments (${JSON.stringify(statusCounts)}), ${today.items.length} appointments today (reported, not compared)`,
  );

  if (Object.keys(seedPatients).length === 0) {
    failures.push(
      `${origin.name}: no seed Patients found — run the demo seed on a fresh database first (bun run seed / go run ./cmd/seed)`,
    );
    continue;
  }
  if (baseline === null) {
    baseline = sortDeep(snapshot);
  } else if (JSON.stringify(sortDeep(snapshot)) !== JSON.stringify(baseline)) {
    failures.push(`${origin.name}: demo dataset differs from the first backend`);
    console.log('  baseline:', JSON.stringify(baseline, null, 1));
    console.log('  this one:', JSON.stringify(sortDeep(snapshot), null, 1));
  }
}

if (failures.length) {
  console.error(`\nparity check FAILED:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nparity check OK: both backends hold the same demo dataset.');
