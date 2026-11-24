#!/usr/bin/env node
// Demo-seed parity check (Go-T18): asserts both backends hold the same demo
// dataset — same demo Members (roles from the org surface), same Patient
// names, same Appointment count per day — by signing in on each origin with
// the documented demo credentials and reading only through the API.
//
//   NESTJS_URL=http://localhost:3101 GO_URL=http://localhost:3102 bun tools/parity-check.mjs
//
// Seeds are applied first by their own commands (bun run seed / go run ./cmd/seed).

const ORIGINS = [
  { name: 'NestJS · MongoDB', url: process.env.NESTJS_URL ?? 'http://localhost:3101' },
  { name: 'Go · PostgreSQL', url: process.env.GO_URL ?? 'http://localhost:3102' },
];
const CREDENTIALS = { email: 'owner@demo.careops', password: 'careops-demo-1' };

const failures = [];
let baseline = null;

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
  const patientNames = new Set();
  let cursor = '';
  for (;;) {
    const page = await (
      await fetch(`${origin.url}/api/patients?limit=100${cursor ? `&cursor=${cursor}` : ''}`, {
        headers,
      })
    ).json();
    for (const p of page.items ?? []) {
      patientNames.add(`${p.firstName} ${p.lastName}`);
    }
    if (!page.nextCursor || !page.hasMore) break;
    cursor = page.nextCursor;
  }
  const patients = {
    items: [...patientNames].map((name) => {
      const [firstName, lastName] = name.split(' ');
      return { firstName, lastName };
    }),
  };
  // The today report is time-sensitive (it counts appointments inside the
  // current UTC day, and fixture slots land wherever the loader put them),
  // so it is reported but not compared.
  const today = await (await fetch(`${origin.url}/api/reports/today`, { headers })).json();

  const snapshot = {
    orgName: me.organization.name,
    role: me.organization.role,
    members: org.members.map((m) => `${m.role}:${m.email}`).sort(),
    // Compare only the fixture-prefixed patients: both orgs carry leftover
    // demo/fixture patients from earlier runs whose newest-100 windows may
    // differ; the loader's fixed 'Fix-cmp-*' names are the parity contract.
    patients: [
      ...new Set(
        patients.items
          .map((p) => `${p.firstName} ${p.lastName}`)
          .filter((name) => name.startsWith('Fix-cmp-')),
      ),
    ].sort(),
  };

  console.log(`\n${origin.name} (${origin.url})`);
  console.log(
    `  org: ${snapshot.orgName} — ${snapshot.members.length} members, ${snapshot.patients.length} patients (fixture-named: ${snapshot.patients.length}), ${today.items.length} appointments today (reported, not compared)`,
  );
  console.log(
    `  fixture names: ${snapshot.patients[0]} .. ${snapshot.patients[snapshot.patients.length - 1]}`,
  );

  if (snapshot.patients.length === 0) {
    failures.push(`${origin.name}: no patients — run the demo seed + parity-fixtures first`);
    continue;
  }
  if (baseline === null) {
    baseline = snapshot;
  } else if (JSON.stringify(snapshot) !== JSON.stringify(baseline)) {
    failures.push(`${origin.name}: demo dataset differs from the first backend`);
    console.log('  baseline:', JSON.stringify(baseline, null, 1));
    console.log('  this one:', JSON.stringify(snapshot, null, 1));
  }
}

if (failures.length) {
  console.error(`\nparity check FAILED:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nparity check OK: both backends hold the same demo dataset.');
