// Measurement dataset for the W2-T9 performance receipts.
//
// Populates a THROWAWAY receipts database (never the demo `careops` db) with a
// representative, deterministic dataset so explain()/bench/k6 numbers are
// meaningful and reproducible. Run the seed against the same db first so the
// demo organization, owner session, and patients exist:
//
//   MONGODB_URI='mongodb://localhost:27017/careops_t9_receipts?replicaSet=rs0' \
//   NOTIFICATIONS_QUEUE_NAME='notifications-t9-receipts' \
//   BETTER_AUTH_SECRET='...32+ chars...' bun apps/api/src/seed.ts
//   bun tools/load-dataset.mjs
//
// It adds synthetic Providers (member + user docs shaped exactly like
// BetterAuth's, so the utilization $lookup resolves names) and regenerates the
// appointment collection across all Providers over a trailing window. The four
// compound indexes mirror apps/api/src/appointments/appointment.schema.ts.

import { MongoClient, ObjectId } from './lib/mongo.mjs';

const MONGODB_URI =
  process.env.MONGODB_URI ?? 'mongodb://localhost:27017/careops_t9_receipts?replicaSet=rs0';
const PROVIDERS = Number(process.env.RECEIPTS_PROVIDERS ?? 40);
const APPOINTMENTS = Number(process.env.RECEIPTS_APPOINTMENTS ?? 20000);
const NOISE_APPOINTMENTS = Number(process.env.RECEIPTS_NOISE ?? 60000);
const DAYS = Number(process.env.RECEIPTS_DAYS ?? 90);
const SEED = Number(process.env.RECEIPTS_SEED ?? 12345);

const STATUSES = [
  'SCHEDULED',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
];
const DURATIONS = [30, 30, 30, 60];
const MS_PER_DAY = 86_400_000;
const SYNTHETIC_EMAIL = /@receipts\.test$/;

// The exact indexes the API declares (ADR-0006: every index leads with
// organizationId). Kept in sync with appointment.schema.ts by hand — this
// script runs outside the Nest process, so mongoose autoIndex never fires.
const APPOINTMENT_INDEXES = [
  { key: { organizationId: 1, memberId: 1, start: 1 }, name: 'org_member_start' },
  { key: { organizationId: 1, _id: 1 }, name: 'org_id_cursor' },
  { key: { organizationId: 1, start: 1 }, name: 'org_start' },
  { key: { organizationId: 1, status: 1, start: 1 }, name: 'org_status_start' },
];

// mulberry32: a tiny deterministic PRNG so every run yields the same dataset.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

async function main() {
  const rand = mulberry32(SEED);
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();

  // Resolve the demo organization from the patient collection: patients exist
  // only for the demo org and are never regenerated here, so this is stable
  // even when a prior run left synthetic noise tenants in the appointment
  // collection (reading appointment.findOne({}) could land on a noise doc).
  const seedPatient = await db
    .collection('patient')
    .findOne({}, { projection: { organizationId: 1 } });
  if (!seedPatient) {
    throw new Error(
      'No seeded patient found. Run `bun apps/api/src/seed.ts` against this db first.',
    );
  }
  const organizationId = seedPatient.organizationId; // string form (API collections)
  const orgOid = new ObjectId(organizationId); // BetterAuth member.organizationId is an ObjectId

  const patients = await db
    .collection('patient')
    .find({ organizationId }, { projection: { _id: 1 } })
    .toArray();
  if (patients.length === 0) {
    throw new Error('No seeded patients found for the demo organization.');
  }
  const patientIds = patients.map((p) => String(p._id));

  // Real demo members (owner/admin/member) stay; synthetic Providers are
  // rebuilt idempotently so re-running never duplicates them. Delete the prior
  // run's synthetic users + members FIRST, then read the demo members — reading
  // before the cleanup would fold the previous run's synthetic ids into the
  // Provider list and leave appointments pointing at deleted member docs.
  const priorSyntheticUsers = await db
    .collection('user')
    .find({ email: SYNTHETIC_EMAIL }, { projection: { _id: 1 } })
    .toArray();
  if (priorSyntheticUsers.length > 0) {
    const ids = priorSyntheticUsers.map((u) => u._id);
    await db.collection('member').deleteMany({ userId: { $in: ids } });
    await db.collection('user').deleteMany({ _id: { $in: ids } });
  }
  const demoMembers = await db.collection('member').find({ organizationId: orgOid }).toArray();

  const now = new Date();
  const providerMemberIds = demoMembers.map((m) => String(m._id));
  for (let i = 0; i < PROVIDERS; i += 1) {
    const userId = new ObjectId();
    const memberId = new ObjectId();
    const label = String(i + 1).padStart(2, '0');
    await db.collection('user').insertOne({
      _id: userId,
      name: `Receipts Provider ${label}`,
      email: `provider${label}@receipts.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('member').insertOne({
      _id: memberId,
      organizationId: orgOid,
      userId,
      role: 'member',
      createdAt: now,
    });
    providerMemberIds.push(String(memberId));
  }

  // Regenerate appointments across the trailing window [-DAYS+1 .. +1] so the
  // dashboard's 30-day volume, status rates, today, and utilization all have
  // data, and the overlap/list queries face a realistically large collection.
  // Wipe the WHOLE collection (throwaway db): a fresh noise-org id each run
  // would otherwise leave prior runs' noise tenants behind and accumulate.
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  await db.collection('appointment').deleteMany({});
  const batch = [];
  for (let i = 0; i < APPOINTMENTS; i += 1) {
    const dayOffset = Math.floor(rand() * (DAYS + 1)) - (DAYS - 1); // -(DAYS-1) .. +1
    const hour = 8 + Math.floor(rand() * 10); // 08:00 .. 17:00
    const durationMinutes = pick(rand, DURATIONS);
    const start = new Date(midnight + dayOffset * MS_PER_DAY + hour * 3_600_000);
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    // Past visits skew terminal; future visits skew upcoming — like a real clinic.
    const status =
      dayOffset < 0
        ? pick(rand, ['COMPLETED', 'COMPLETED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])
        : dayOffset === 0
          ? pick(rand, ['CHECKED_IN', 'IN_PROGRESS', 'SCHEDULED', 'COMPLETED'])
          : pick(rand, ['SCHEDULED', 'CONFIRMED']);
    batch.push({
      organizationId,
      patientId: pick(rand, patientIds),
      memberId: pick(rand, providerMemberIds),
      start,
      end,
      durationMinutes,
      status,
      createdAt: start,
      updatedAt: start,
    });
    if (batch.length === 2000) {
      await db.collection('appointment').insertMany(batch);
      batch.length = 0;
    }
  }
  if (batch.length > 0) {
    await db.collection('appointment').insertMany(batch);
  }

  // A second, larger tenant. The cursor-list index ({organizationId, _id})
  // only proves its value in a multi-tenant collection: without it, the
  // newest-first _id walk crosses every other tenant's documents before
  // reaching this org's page. Inserted AFTER the demo org so its ObjectIds
  // sort newer — the reverse walk hits the noise tenant first.
  const noiseOrgId = new ObjectId().toString();
  const noiseBatch = [];
  for (let i = 0; i < NOISE_APPOINTMENTS; i += 1) {
    const dayOffset = Math.floor(rand() * (DAYS + 1)) - (DAYS - 1);
    const hour = 8 + Math.floor(rand() * 10);
    const durationMinutes = pick(rand, DURATIONS);
    const start = new Date(midnight + dayOffset * MS_PER_DAY + hour * 3_600_000);
    noiseBatch.push({
      organizationId: noiseOrgId,
      patientId: new ObjectId().toString(),
      memberId: new ObjectId().toString(),
      start,
      end: new Date(start.getTime() + durationMinutes * 60_000),
      durationMinutes,
      status: pick(rand, STATUSES),
      createdAt: start,
      updatedAt: start,
    });
    if (noiseBatch.length === 2000) {
      await db.collection('appointment').insertMany(noiseBatch);
      noiseBatch.length = 0;
    }
  }
  if (noiseBatch.length > 0) {
    await db.collection('appointment').insertMany(noiseBatch);
  }

  await db.collection('appointment').createIndexes(APPOINTMENT_INDEXES);

  const total = await db.collection('appointment').countDocuments({ organizationId });
  const noiseTotal = await db
    .collection('appointment')
    .countDocuments({ organizationId: noiseOrgId });
  const providers = await db.collection('member').countDocuments({ organizationId: orgOid });
  console.log('Receipts dataset loaded.');
  console.log('  Database      :', db.databaseName);
  console.log('  Organization  :', organizationId);
  console.log('  Providers     : %d (3 demo + %d synthetic)', providers, PROVIDERS);
  console.log(
    '  Appointments  : %d demo org + %d noise tenant, over %d days',
    total,
    noiseTotal,
    DAYS,
  );
  console.log('  Indexes       :', APPOINTMENT_INDEXES.map((i) => i.name).join(', '));
  await client.close();
}

main()
  .catch((error) => {
    console.error('load-dataset failed:', error.message);
    process.exitCode = 1;
  })
  .then(() => process.exit(process.exitCode ?? 0));
