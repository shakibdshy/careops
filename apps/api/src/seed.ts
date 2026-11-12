import dotenv from 'dotenv';
// Resolve the API's .env regardless of the caller's working directory
// (bun run boot executes this script from the repo root).
dotenv.config({ path: new URL('../.env', import.meta.url) });
import { MongoClient, ObjectId } from 'mongodb';
import mongoose from 'mongoose';
import type { AppointmentStatus } from '@careops/shared';
import { loadConfig } from './config/env.js';
import { createBetterAuth } from './auth/auth.factory.js';

const OWNER = { name: 'Dana Owner', email: 'owner@demo.careops', password: 'careops-demo-1' };
const ADMIN = { name: 'Alex Admin', email: 'admin@demo.careops', password: 'careops-demo-1' };
const MEMBER = { name: 'Morgan Member', email: 'member@demo.careops', password: 'careops-demo-1' };

const PATIENTS = [
  {
    firstName: 'Ada',
    lastName: 'Lovelace',
    dateOfBirth: '1990-12-10',
    phone: '555-0100',
    contactEmail: 'ada.lovelace@example.test',
    notes: 'Prefers morning appointments.',
  },
  {
    firstName: 'Grace',
    lastName: 'Hopper',
    dateOfBirth: '1944-06-09',
    phone: '555-0101',
    contactEmail: 'grace.hopper@example.test',
    notes: 'Coordinate with her aide.',
  },
  {
    firstName: 'Alan',
    lastName: 'Turing',
    dateOfBirth: '1982-05-14',
    contactEmail: 'alan.turing@example.test',
  },
  {
    firstName: 'Katherine',
    lastName: 'Johnson',
    dateOfBirth: '1978-11-05',
    contactEmail: 'katherine.johnson@example.test',
    notes: 'Follow-up in two weeks.',
  },
];

/**
 * Appointment fixtures (W2-T4): one clinic week relative to the seed day, in
 * UTC. Every Provider's slots are disjoint, so the demo data satisfies the
 * same Conflict invariant the API enforces. Tomorrow's SCHEDULED/CONFIRMED
 * visits are the reminder candidates W2-T8 schedules against (start − 24h).
 */
interface AppointmentFixture {
  dayOffset: number;
  hour: number;
  durationMinutes: number;
  status: AppointmentStatus;
  patientIndex: number;
  provider: 'owner' | 'admin' | 'member';
  notes?: string;
}

const PAST_WEEK = [-7, -6, -5, -4, -3, -2, -1];

const APPOINTMENT_FIXTURES: AppointmentFixture[] = [
  // Completed visits across the past week feed the dashboard's volume trend.
  ...PAST_WEEK.flatMap((dayOffset): AppointmentFixture[] => [
    {
      dayOffset,
      hour: 9,
      durationMinutes: 30,
      status: 'COMPLETED',
      patientIndex: Math.abs(dayOffset) % PATIENTS.length,
      provider: 'owner',
    },
    {
      dayOffset,
      hour: 10,
      durationMinutes: 30,
      status: 'COMPLETED',
      patientIndex: (Math.abs(dayOffset) + 1) % PATIENTS.length,
      provider: 'admin',
    },
  ]),
  // Terminal outcomes in the recent past feed the status-breakdown rates.
  {
    dayOffset: -2,
    hour: 11,
    durationMinutes: 30,
    status: 'CANCELLED',
    patientIndex: 1,
    provider: 'member',
    notes: 'Patient requested a later date.',
  },
  {
    dayOffset: -3,
    hour: 14,
    durationMinutes: 30,
    status: 'NO_SHOW',
    patientIndex: 2,
    provider: 'owner',
  },
  // Today: the clinic is mid-flow.
  {
    dayOffset: 0,
    hour: 9,
    durationMinutes: 30,
    status: 'CHECKED_IN',
    patientIndex: 0,
    provider: 'owner',
    notes: 'Arrived early.',
  },
  {
    dayOffset: 0,
    hour: 9,
    durationMinutes: 60,
    status: 'IN_PROGRESS',
    patientIndex: 1,
    provider: 'admin',
  },
  {
    dayOffset: 0,
    hour: 14,
    durationMinutes: 30,
    status: 'SCHEDULED',
    patientIndex: 3,
    provider: 'owner',
  },
  {
    dayOffset: 0,
    hour: 15,
    durationMinutes: 30,
    status: 'SCHEDULED',
    patientIndex: 2,
    provider: 'member',
  },
  // Tomorrow: upcoming visits, some already confirmed.
  {
    dayOffset: 1,
    hour: 9,
    durationMinutes: 30,
    status: 'SCHEDULED',
    patientIndex: 0,
    provider: 'owner',
  },
  {
    dayOffset: 1,
    hour: 10,
    durationMinutes: 30,
    status: 'SCHEDULED',
    patientIndex: 1,
    provider: 'admin',
  },
  {
    dayOffset: 1,
    hour: 11,
    durationMinutes: 30,
    status: 'CONFIRMED',
    patientIndex: 2,
    provider: 'owner',
  },
  {
    dayOffset: 1,
    hour: 14,
    durationMinutes: 30,
    status: 'CONFIRMED',
    patientIndex: 3,
    provider: 'member',
  },
];

async function sessionHeaders(
  auth: ReturnType<typeof createAuth>,
  email: string,
  password: string,
): Promise<Headers> {
  const res = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  // The response's set-cookie list must be replayed as a Cookie request header.
  const headers = new Headers();
  for (const cookie of res.headers.getSetCookie()) {
    headers.append('cookie', cookie.split(';')[0] ?? '');
  }
  return headers;
}

const createAuth = createBetterAuth;

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new MongoClient(config.mongoUri);
  await client.connect();
  const db = client.db();
  const auth = createAuth(config, client);

  // Idempotent: skip when the demo owner already exists.
  if (await db.collection('user').findOne({ email: OWNER.email })) {
    console.log('Seed skipped: demo data already present.');
    return;
  }

  await mongoose.connect(config.mongoUri);

  // Signup fires the org-creation hook; the creator becomes owner (T4).
  for (const user of [OWNER, ADMIN, MEMBER]) {
    console.log('SEED: signing up', user.email);
    await auth.api.signUpEmail({ body: user });
  }

  const ownerUser = (await db.collection('user').findOne({ email: OWNER.email }))!;
  // The signup hook (T4) already created the owner's Organization — bare
  // server-side createOrganization calls are rejected without a session.
  console.log('SEED: signing in owner');
  const ownerHeaders = await sessionHeaders(auth, OWNER.email, OWNER.password);
  console.log('SEED: listing orgs');
  const org = (await auth.api.listOrganizations({ headers: ownerHeaders }))[0]!;
  await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: ownerHeaders });

  console.log('SEED: inviting admin+member');
  for (const [email, role] of [
    [ADMIN.email, 'admin'],
    [MEMBER.email, 'member'],
  ] as const) {
    console.log('SEED: inviting', email);
    const invitation = await auth.api.createInvitation({
      body: { email, role, organizationId: org.id },
      headers: ownerHeaders,
    });
    const memberHeaders = await sessionHeaders(
      auth,
      email,
      email === ADMIN.email ? ADMIN.password : MEMBER.password,
    );
    console.log('SEED: accepting as', email);
    await auth.api.acceptInvitation({
      body: { invitationId: invitation.id },
      headers: memberHeaders,
    });
    await auth.api.setActiveOrganization({
      body: { organizationId: org.id },
      headers: memberHeaders,
    });
  }

  const ownerId = String(ownerUser._id);
  const patientIds: string[] = [];
  for (const patient of PATIENTS) {
    // Direct collection writes: the org-scoped repository base lives in the
    // Nest process — the seed runs outside it and scopes organizationId by
    // hand (same discriminator-key guarantee, no app code involved).
    const inserted = await db.collection('patient').insertOne({
      organizationId: org.id,
      ...patient,
      dateOfBirth: new Date(patient.dateOfBirth),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    patientIds.push(String(inserted.insertedId));
    await db.collection('audit_entry').insertOne({
      organizationId: org.id,
      actorId: ownerId,
      actorEmail: OWNER.email,
      action: 'create',
      entity: 'patient',
      entityId: String(inserted.insertedId),
      before: null,
      after: patient,
      at: new Date(),
    });
  }

  // Provider = the Member assigned to the Appointment (glossary). Resolve the
  // demo members' ids from BetterAuth's member collection, by role. BetterAuth
  // stores organizationId as an ObjectId there (the API's own collections use
  // the string form).
  const memberIdByRole: Record<string, string> = {};
  for (const member of await db
    .collection('member')
    .find({ organizationId: new ObjectId(org.id) })
    .toArray()) {
    memberIdByRole[member.role as string] = String(member._id);
  }

  const seedDay = new Date();
  seedDay.setUTCHours(0, 0, 0, 0);
  for (const fixture of APPOINTMENT_FIXTURES) {
    const start = new Date(
      seedDay.getTime() + fixture.dayOffset * 86_400_000 + fixture.hour * 3_600_000,
    );
    const end = new Date(start.getTime() + fixture.durationMinutes * 60_000);
    const memberId = memberIdByRole[fixture.provider];
    if (!memberId) {
      throw new Error(`Demo organization has no ${fixture.provider} member`);
    }
    const inserted = await db.collection('appointment').insertOne({
      organizationId: org.id,
      patientId: patientIds[fixture.patientIndex],
      memberId,
      start,
      end,
      durationMinutes: fixture.durationMinutes,
      status: fixture.status,
      ...(fixture.notes !== undefined ? { notes: fixture.notes } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('audit_entry').insertOne({
      organizationId: org.id,
      actorId: ownerId,
      actorEmail: OWNER.email,
      action: 'create',
      entity: 'appointment',
      entityId: String(inserted.insertedId),
      before: null,
      after: {
        patientId: patientIds[fixture.patientIndex],
        memberId,
        start: start.toISOString(),
        end: end.toISOString(),
        durationMinutes: fixture.durationMinutes,
        status: fixture.status,
        ...(fixture.notes !== undefined ? { notes: fixture.notes } : {}),
      },
      at: new Date(),
    });
  }

  console.log('Seed complete.');
  console.log('  Organization:', org.name);
  console.log('  Appointments: %d fixtures across all 7 statuses', APPOINTMENT_FIXTURES.length);
  console.log('  Owner  : %s / %s', OWNER.email, OWNER.password);
  console.log('  Admin  : %s / %s', ADMIN.email, ADMIN.password);
  console.log('  Member : %s / %s', MEMBER.email, MEMBER.password);

  await mongoose.disconnect();
  await client.close();
}

void main()
  .catch((error) => {
    console.error(
      'Seed failed:',
      JSON.stringify({
        message: (error as { message?: string }).message,
        body: (error as { body?: unknown }).body,
        status: (error as { status?: number }).status,
      }),
    );
    process.exitCode = 1;
  })
  .then(() => process.exit(process.exitCode ?? 0));
