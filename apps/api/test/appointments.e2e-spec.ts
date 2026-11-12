import request from 'supertest';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import {
  appointmentsPageSchema,
  appointmentSchema,
  errorResponseSchema,
  invitationSchema,
  organizationCurrentSchema,
  patientSchema,
} from '@careops/shared';
import { setupE2eApp, type E2eHarness } from './mongo.js';

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
const STRANGER = {
  name: 'Owner B',
  email: 'owner-b@example.test',
  password: 'correct-horse-battery-staple',
};

const validPatient = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  dateOfBirth: '1990-12-10',
};

// Fixed future slots — appointments carry no past constraint (only Patient
// dateOfBirth does), so absolute dates keep this spec date-independent.
const SLOT_A = '2026-12-01T10:00:00.000Z'; // 10:00–10:30
const SLOT_A_B = '2026-12-01T10:30:00.000Z'; // back-to-back, 10:30–11:00
const SLOT_ELEVEN = '2026-12-01T11:00:00.000Z';
const SLOT_LATER = '2026-12-01T14:00:00.000Z';

function bookingOf(patientId: string, memberId: string) {
  return {
    patientId,
    memberId,
    start: SLOT_A,
    durationMinutes: 30,
  };
}

describe('Appointments (e2e)', () => {
  let app: INestApplication<App>;
  let harness: E2eHarness;
  let ownerAgent: ReturnType<typeof request.agent>;
  let memberAgent: ReturnType<typeof request.agent>;
  let strangerAgent: ReturnType<typeof request.agent>;
  let patientId: string;
  let ownerMemberId: string;
  let memberMemberId: string;

  const book = (agent: ReturnType<typeof request.agent>, body: Record<string, unknown>) =>
    agent.post('/api/appointments').send(body);

  beforeAll(async () => {
    harness = await setupE2eApp('careops-appointments-test');
    app = harness.app;
    ownerAgent = request.agent(app.getHttpServer());
    memberAgent = request.agent(app.getHttpServer());
    strangerAgent = request.agent(app.getHttpServer());

    await ownerAgent.post('/api/auth/sign-up/email').send(OWNER).expect(200);
    await memberAgent.post('/api/auth/sign-up/email').send(MEMBER).expect(200);
    await strangerAgent.post('/api/auth/sign-up/email').send(STRANGER).expect(200);

    // Member joins the owner's organization via the invitation flow.
    const meRes = await ownerAgent.get('/api/workspace/me').expect(200);
    const ownerOrgId = (meRes.body as { organization: { id: string } }).organization.id;
    const invitationRes = await ownerAgent
      .post('/api/organizations/invitations')
      .send({ email: MEMBER.email, role: 'member' })
      .expect(201);
    const invitationId = invitationSchema.parse(invitationRes.body).id;
    await memberAgent
      .post('/api/auth/organization/accept-invitation')
      .set('Origin', 'http://localhost:3000')
      .send({ invitationId })
      .expect(200);
    await memberAgent
      .post('/api/auth/organization/set-active')
      .send({ organizationId: ownerOrgId })
      .expect(200);

    const patientRes = await ownerAgent.post('/api/patients').send(validPatient).expect(201);
    patientId = patientSchema.parse(patientRes.body).id;

    // Provider ids from the API's own member surface — the exact ids the
    // booking endpoint resolves against (BetterAuth adapter-owned, opaque).
    const current = organizationCurrentSchema.parse(
      (await ownerAgent.get('/api/organizations/current').expect(200)).body,
    );
    if (current.id !== ownerOrgId) {
      throw new Error('organization surface does not match the active org');
    }
    const ownerMember = current.members.find((m) => m.role === 'owner');
    const memberMember = current.members.find((m) => m.role === 'member');
    if (!ownerMember || !memberMember) {
      throw new Error('Expected one owner and one member in the seeded organization');
    }
    ownerMemberId = ownerMember.id;
    memberMemberId = memberMember.id;
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('booking', () => {
    it('books an appointment: SCHEDULED, Z-normalized start, audited later by read', async () => {
      const res = await book(ownerAgent, {
        ...bookingOf(patientId, ownerMemberId),
        notes: 'first booking',
      }).expect(201);
      const appointment = appointmentSchema.parse(res.body);
      expect(appointment.status).toBe('SCHEDULED');
      expect(appointment.start).toBe(SLOT_A);
      expect(appointment.durationMinutes).toBe(30);
      expect(appointment.organizationId).not.toBe('');
    });

    it('normalizes an offset start to UTC Z-form', async () => {
      const res = await book(ownerAgent, {
        ...bookingOf(patientId, memberMemberId),
        start: '2026-12-02T12:00:00.000+02:00', // == 10:00Z
      }).expect(201);
      const appointment = appointmentSchema.parse(res.body);
      expect(appointment.start).toBe('2026-12-02T10:00:00.000Z');
    });

    it('rejects an overlapping slot with a hard 409 in the shared taxonomy', async () => {
      const res = await book(ownerAgent, bookingOf(patientId, ownerMemberId)).expect(409);
      const parsed = errorResponseSchema.parse(res.body);
      expect(parsed.statusCode).toBe(409);
      expect(parsed.message).toMatch(/overlap/i);
    });

    it('allows back-to-back slots for the same provider', async () => {
      await book(ownerAgent, {
        ...bookingOf(patientId, ownerMemberId),
        start: SLOT_A_B,
      }).expect(201);
    });

    it('allows the same slot for a different provider', async () => {
      await book(ownerAgent, {
        ...bookingOf(patientId, memberMemberId),
        start: SLOT_A,
      }).expect(201);
    });

    it('only one of two concurrent bookings of the same slot wins', async () => {
      const body = { ...bookingOf(patientId, ownerMemberId), start: SLOT_LATER };
      const [first, second] = await Promise.all([book(ownerAgent, body), book(ownerAgent, body)]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
    });

    it('rejects malformed bookings with 400 field errors, never CastErrors', async () => {
      const badStart = await book(ownerAgent, {
        ...bookingOf(patientId, ownerMemberId),
        start: 'not-a-datetime',
      }).expect(400);
      expect(errorResponseSchema.parse(badStart.body).errors.length).toBeGreaterThan(0);

      await book(ownerAgent, {
        ...bookingOf(patientId, ownerMemberId),
        durationMinutes: 10,
      }).expect(400);
      await book(ownerAgent, {
        ...bookingOf(patientId, ownerMemberId),
        durationMinutes: 500,
      }).expect(400);
      await book(ownerAgent, {
        ...bookingOf(patientId, ownerMemberId),
        patientId: 'nothex',
      }).expect(400);
    });

    it('is 404 when the referenced patient or provider does not exist here', async () => {
      await book(ownerAgent, bookingOf('f'.repeat(24), ownerMemberId)).expect(404);
      await book(ownerAgent, bookingOf(patientId, 'e'.repeat(24))).expect(404);
    });

    it('denies a member booking (RBAC) but allows them to read', async () => {
      await book(memberAgent, bookingOf(patientId, memberMemberId)).expect(403);
      await memberAgent.get('/api/appointments').expect(200);
    });
  });

  describe('reading', () => {
    it('fetches one appointment', async () => {
      const listRes = await ownerAgent.get('/api/appointments?limit=1').expect(200);
      const page = appointmentsPageSchema.parse(listRes.body);
      const first = page.items[0];
      if (!first) {
        throw new Error('expected at least one appointment');
      }
      const res = await ownerAgent.get(`/api/appointments/${first.id}`).expect(200);
      expect(appointmentSchema.parse(res.body).id).toBe(first.id);
    });

    it('is 404-not-403 for another organization (tenancy isolation)', async () => {
      const listRes = await ownerAgent.get('/api/appointments?limit=1').expect(200);
      const someId = appointmentsPageSchema.parse(listRes.body).items[0]?.id;
      if (!someId) {
        throw new Error('expected at least one appointment');
      }
      await strangerAgent.get(`/api/appointments/${someId}`).expect(404);
    });

    it('another organization sees none of our appointments in lists', async () => {
      const res = await strangerAgent.get('/api/appointments').expect(200);
      expect(appointmentsPageSchema.parse(res.body).items).toHaveLength(0);
    });

    it('paginates newest-first with non-overlapping cursor pages', async () => {
      const first = appointmentsPageSchema.parse(
        (await ownerAgent.get('/api/appointments?limit=2').expect(200)).body,
      );
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      const second = appointmentsPageSchema.parse(
        (await ownerAgent.get(`/api/appointments?limit=2&cursor=${first.nextCursor}`).expect(200))
          .body,
      );
      const firstIds = first.items.map((a) => a.id);
      const secondIds = second.items.map((a) => a.id);
      expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
    });

    it('filters by status, provider, and start window', async () => {
      const scheduled = appointmentsPageSchema.parse(
        (await ownerAgent.get('/api/appointments?status=SCHEDULED').expect(200)).body,
      );
      expect(scheduled.items.every((a) => a.status === 'SCHEDULED')).toBe(true);

      const byProvider = appointmentsPageSchema.parse(
        (await ownerAgent.get(`/api/appointments?memberId=${memberMemberId}`).expect(200)).body,
      );
      expect(byProvider.items.length).toBeGreaterThanOrEqual(2);
      expect(byProvider.items.every((a) => a.memberId === memberMemberId)).toBe(true);

      const windowed = appointmentsPageSchema.parse(
        (
          await ownerAgent
            .get('/api/appointments?from=2026-12-01T09:00:00.000Z&to=2026-12-01T11:00:00.000Z')
            .expect(200)
        ).body,
      );
      expect(windowed.items.length).toBeGreaterThanOrEqual(2);
      expect(
        windowed.items.every(
          (a) => a.start >= '2026-12-01T09:00:00.000Z' && a.start <= '2026-12-01T11:00:00.000Z',
        ),
      ).toBe(true);

      const empty = appointmentsPageSchema.parse(
        (
          await ownerAgent
            .get('/api/appointments?from=2026-12-01T11:01:00.000Z&to=2026-12-01T12:00:00.000Z')
            .expect(200)
        ).body,
      );
      expect(empty.items).toHaveLength(0);
    });

    it('rejects malformed filters with 400s', async () => {
      await ownerAgent.get('/api/appointments?status=RESCHEDULED').expect(400);
      await ownerAgent.get('/api/appointments?cursor=zzz').expect(400);
      await ownerAgent
        .get('/api/appointments?from=2026-12-01T11:00:00.000Z&to=2026-12-01T09:00:00.000Z')
        .expect(400);
    });
  });

  describe('audit', () => {
    it('every booking wrote an audit entry with null→after state', async () => {
      const res = await book(ownerAgent, {
        ...bookingOf(patientId, ownerMemberId),
        start: SLOT_ELEVEN,
      }).expect(201);
      const appointment = appointmentSchema.parse(res.body);
      // Audit Entries are verified through the datastore (same seam the
      // patients e2e uses) until an audit read endpoint exists for them.
      const connection = app.get<Connection>(getConnectionToken());
      const entries = await connection.db
        ?.collection('audit_entry')
        .find({
          organizationId: appointment.organizationId,
          entity: 'appointment',
          entityId: appointment.id,
        })
        .toArray();
      expect(entries).toHaveLength(1);
      expect(entries?.[0]?.actorEmail).toBe(OWNER.email);
      expect(entries?.[0]?.action).toBe('create');
      expect(entries?.[0]?.before).toBeNull();
    });
  });
});
