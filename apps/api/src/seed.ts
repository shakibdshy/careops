import 'dotenv/config';
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
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
    notes: 'Prefers morning appointments.',
  },
  {
    firstName: 'Grace',
    lastName: 'Hopper',
    dateOfBirth: '1944-06-09',
    phone: '555-0101',
    notes: 'Coordinate with her aide.',
  },
  { firstName: 'Alan', lastName: 'Turing', dateOfBirth: '1982-05-14' },
  {
    firstName: 'Katherine',
    lastName: 'Johnson',
    dateOfBirth: '1978-11-05',
    notes: 'Follow-up in two weeks.',
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

  console.log('Seed complete.');
  console.log('  Organization:', org.name);
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
