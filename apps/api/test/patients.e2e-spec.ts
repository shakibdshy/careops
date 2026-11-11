import request from 'supertest';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import {
  createPatientSchema,
  errorResponseSchema,
  patientsPageSchema,
  patientSchema,
} from '@careops/shared';
import { AppModule } from '../src/app.module.js';
import { bootstrapApi } from '../src/bootstrap-api.js';

const OWNER = {
  name: 'Owner A',
  email: 'owner-a@example.test',
  password: 'correct-horse-battery-staple',
};
const MEMBER = {
  name: 'Member A',
  email: 'member-a@example.test',
  password: 'correct-horse-battery-staple',
};
const OWNER_B = {
  name: 'Owner B',
  email: 'owner-b@example.test',
  password: 'correct-horse-battery-staple',
};

const validPatient = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  dateOfBirth: '1990-12-10',
  phone: '555-0100',
  notes: 'first patient',
};

describe('Patients (e2e)', () => {
  let app: INestApplication<App>;
  let mongo: MongoMemoryServer;
  let ownerAgent: ReturnType<typeof request.agent>;
  let memberAgent: ReturnType<typeof request.agent>;
  let strangerAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongo.getUri('careops-patients-test');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    bootstrapApi(app);
    app.setGlobalPrefix('api');
    await app.init();
    ownerAgent = request.agent(app.getHttpServer());
    memberAgent = request.agent(app.getHttpServer());
    strangerAgent = request.agent(app.getHttpServer());

    await ownerAgent.post('/api/auth/sign-up/email').send(OWNER).expect(200);
    await memberAgent.post('/api/auth/sign-up/email').send(MEMBER).expect(200);
    await strangerAgent.post('/api/auth/sign-up/email').send(OWNER_B).expect(200);

    // Member joins Owner A's organization.
    const invitation = await ownerAgent
      .post('/api/organizations/invitations')
      .send({ email: MEMBER.email, role: 'member' })
      .expect(201);
    await memberAgent
      .post('/api/auth/organization/accept-invitation')
      .set('Origin', 'http://localhost:3000')
      .send({ invitationId: (invitation.body as { id: string }).id })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await mongo.stop();
  });

  describe('create', () => {
    it('an owner creates a patient; response matches the shared contract', async () => {
      const res = await ownerAgent.post('/api/patients').send(validPatient).expect(201);
      const patient = patientSchema.parse(res.body);
      expect(patient.firstName).toBe('Ada');
      expect(patient.lastName).toBe('Lovelace');
      expect(patient.dateOfBirth).toBe('1990-12-10T00:00:00.000Z');
    });

    it('a member cannot create patients (403, shared taxonomy)', async () => {
      const res = await memberAgent.post('/api/patients').send(validPatient);
      expect(res.status).toBe(403);
      errorResponseSchema.parse(res.body);
    });

    it('an invalid payload fails with field-level errors in the shared taxonomy', async () => {
      const res = await ownerAgent
        .post('/api/patients')
        .send({ firstName: '', lastName: 'Doe', dateOfBirth: 'not-a-date' });
      expect(res.status).toBe(400);
      const parsed = errorResponseSchema.parse(res.body);
      const fields = parsed.errors.map((error) => error.field);
      expect(fields).toContain('firstName');
      expect(fields).toContain('dateOfBirth');
    });

    it('rejects a future date of birth', async () => {
      const res = await ownerAgent
        .post('/api/patients')
        .send({ ...validPatient, dateOfBirth: '2999-01-01' });
      expect(res.status).toBe(400);
      const parsed = errorResponseSchema.parse(res.body);
      expect(parsed.errors.some((error) => error.field === 'dateOfBirth')).toBe(true);
    });

    it('an unauthenticated request is denied with 401', async () => {
      const res = await request(app.getHttpServer()).post('/api/patients').send(validPatient);
      expect(res.status).toBe(401);
      errorResponseSchema.parse(res.body);
    });
  });

  describe('list + cursor pagination', () => {
    beforeAll(async () => {
      // Two more patients so pagination has >1 page at limit 2 (3 total).
      await ownerAgent
        .post('/api/patients')
        .send({ ...validPatient, firstName: 'Grace', lastName: 'Hopper' })
        .expect(201);
      await ownerAgent
        .post('/api/patients')
        .send({ ...validPatient, firstName: 'Alan', lastName: 'Turing' })
        .expect(201);
    });

    it('a member lists patients within their organization', async () => {
      const res = await memberAgent.get('/api/patients?limit=2').expect(200);
      const page = patientsPageSchema.parse(res.body);
      expect(page.items.length).toBe(2);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBeDefined();
    });

    it('following the cursor yields the remaining page without overlap', async () => {
      const first = patientsPageSchema.parse(
        (await memberAgent.get('/api/patients?limit=2').expect(200)).body,
      );
      const second = patientsPageSchema.parse(
        (await memberAgent.get(`/api/patients?limit=2&cursor=${first.nextCursor}`).expect(200))
          .body,
      );
      expect(second.items.length).toBe(1);
      const firstIds = first.items.map((patient) => patient.id);
      const secondIds = second.items.map((patient) => patient.id);
      expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
      expect([...firstIds, ...secondIds]).toHaveLength(3);
    });

    it('every returned patient validates against the shared schema', async () => {
      const page = patientsPageSchema.parse(
        (await memberAgent.get('/api/patients?limit=100').expect(200)).body,
      );
      expect(page.items.length).toBe(3);
      for (const patient of page.items) {
        expect(patientSchema.parse(patient)).toBeDefined();
        expect(createPatientSchema.safeParse(patient).success).toBe(true);
      }
    });
  });

  describe('tenant isolation', () => {
    let strangerPatientId: string;

    beforeAll(async () => {
      // Organization B (stranger) creates their own patient.
      const res = await strangerAgent.post('/api/patients').send(validPatient).expect(201);
      strangerPatientId = (res.body as { id: string }).id;
    });

    it("organization A's list never contains organization B's patients", async () => {
      const page = patientsPageSchema.parse(
        (await ownerAgent.get('/api/patients?limit=100').expect(200)).body,
      );
      expect(page.items.map((patient) => patient.id)).not.toContain(strangerPatientId);
    });

    it('direct fetch of another organization’s patient is a 404, not a 403', async () => {
      const res = await ownerAgent.get(`/api/patients/${strangerPatientId}`);
      expect(res.status).toBe(404);
      errorResponseSchema.parse(res.body);
    });
  });

  describe('audit trail', () => {
    it('every patient creation wrote an audit entry with null→after state', async () => {
      // No audit READ endpoint exists yet (T6) — until then the write side is
      // verified through the datastore; this test is superseded by the
      // endpoint test in T6.
      const res = await ownerAgent
        .post('/api/patients')
        .send({ ...validPatient, firstName: 'Audit', lastName: 'Probe' })
        .expect(201);
      const patient = patientSchema.parse(res.body);
      const connection = app.get<Connection>(getConnectionToken());
      const entries = await connection.db
        ?.collection('audit_entry')
        .find({ organizationId: patient.organizationId, entity: 'patient', entityId: patient.id })
        .toArray();
      expect(entries).toHaveLength(1);
      const entry = entries?.[0];
      expect(entry?.actorEmail).toBe(OWNER.email);
      expect(entry?.action).toBe('create');
      expect(entry?.before).toBeNull();
      expect((entry?.after as Record<string, unknown> | null)?.['firstName']).toBe('Audit');
    });
  });
});
