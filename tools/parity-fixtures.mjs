#!/usr/bin/env node
// Comparison fixture loader (Go-T17): creates the SAME demo dataset through
// whichever backend BASE_URL names — N patients with M appointments each,
// spread over ±20 days — so both backends hold like-for-like data before the
// k6 comparison runs.
//
//   BASE_URL=http://localhost:3101 bun tools/parity-fixtures.mjs
//
// Uses the documented demo credentials (owner@demo.careops) and is safe to
// re-run: fixture names embed a run stamp, so re-runs add a fresh batch
// instead of colliding.
const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error('usage: BASE_URL=<origin> bun tools/parity-fixtures.mjs');
  process.exit(2);
}

const PATIENTS = Number(process.env.FIXTURE_PATIENTS || 40);
const PER_PATIENT = Number(process.env.FIXTURE_APPOINTMENTS || 3);
const stamp = `${process.pid}${Date.now().toString(36)}`;
let cookie = '';

async function api(path, init = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      cookie,
      ...(init.headers ?? {}),
    },
  });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    if (pair && pair.includes('=')) cookie = pair;
  }
  return res;
}

// Sign in as the demo owner (seeded by apps/api/src/seed.ts or cmd/seed).
const signIn = await api('/api/auth/sign-in/email', {
  method: 'POST',
  body: JSON.stringify({ email: 'owner@demo.careops', password: 'careops-demo-1' }),
});
if (signIn.status !== 200) {
  console.error(`sign-in failed (${signIn.status}) — boot the stack and seed first`);
  process.exit(1);
}

const meRes = await api('/api/workspace/me');
const me = await meRes.json();
const currentRes = await api('/api/organizations/current');
const current = await currentRes.json();
const ownerMember = current.members.find((m) => m.role === 'owner');
if (!ownerMember) {
  console.error('no owner member found');
  process.exit(1);
}
console.log(`signed in as ${me.user.email} in ${me.organization.name}`);

let appointmentsCreated = 0;
for (let i = 0; i < PATIENTS; i++) {
  const patientRes = await api('/api/patients', {
    method: 'POST',
    body: JSON.stringify({
      firstName: `Fix${stamp}${i}`,
      lastName: 'Comparison',
      dateOfBirth: '1985-06-15',
      phone: '555-0100',
      contactEmail: `fix${stamp}${i}@compare.careops.test`,
    }),
  });
  if (patientRes.status !== 201) {
    console.error(`patient ${i} failed: ${patientRes.status} ${await patientRes.text()}`);
    process.exit(1);
  }
  const patient = await patientRes.json();

  for (let a = 0; a < PER_PATIENT; a++) {
    // Spread over ±20 days from today at fixed UTC hours; anything that
    // would land in the past is pushed into the next few hours instead.
    const offsetDays = ((i + a) % 40) - 20;
    const start = new Date(
      Date.parse(
        `${new Date().toISOString().slice(0, 10)}T${String(8 + a * 2).padStart(2, '0')}:00:00Z`,
      ),
    );
    start.setUTCDate(start.getUTCDate() + offsetDays);
    if (start.getTime() < Date.now()) {
      start.setTime(Date.now() + (((i * PER_PATIENT + a) % 300) + 10) * 60_000);
    }
    const booked = await api('/api/appointments', {
      method: 'POST',
      body: JSON.stringify({
        patientId: patient.id,
        memberId: ownerMember.id,
        start: start.toISOString(),
        durationMinutes: 30,
      }),
    });
    if (booked.status === 201) appointmentsCreated++;
  }
  process.stdout.write(`  ${i + 1}/${PATIENTS}\r`);
}

console.log(
  `fixtures ready: ${PATIENTS} patients, ${appointmentsCreated} appointments (org ${me.organization.id})`,
);
