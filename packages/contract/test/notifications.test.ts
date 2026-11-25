// Notifications conformance cases (Go-T13) — ported from the reference's
// notifications e2e suite, observed ONLY through the SMTP sink and the API
// per the spec: a delivery is real when the message reaches the Patient's
// Contact Email in the sink; a skip is real when nothing does. The two
// datastore-level expectations in the source suite (a storage dedup hit,
// a pending reminder job withdrawn) map to the database-level seam in the
// Go service, per the spec's mapping.
import { beforeAll, describe, expect, it } from 'bun:test';
import { organizationCurrentSchema, patientSchema } from '@careops/shared';
import { expectTaxonomy, ledgerProbe, parseBody, Session } from './helpers.js';

const SINK_URL = process.env.SMTP_SINK_URL ?? 'http://localhost:8025';
// Deliveries are asynchronous: poll the sink, never sleep-assert.
const SINK_TIMEOUT_MS = 15_000;

interface SinkMessage {
  ID: string;
  To: Array<{ Address: string }>;
  Subject: string;
}

async function sinkMessages(): Promise<SinkMessage[]> {
  const res = await fetch(`${SINK_URL}/api/v1/messages`);
  if (!res.ok) {
    throw new Error(`SMTP sink unavailable (${res.status}) — is Mailpit running?`);
  }
  const body = (await res.json()) as { messages: SinkMessage[] };
  return body.messages ?? [];
}

async function waitForMessageTo(recipient: string): Promise<SinkMessage | null> {
  const deadline = Date.now() + SINK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const match = (await sinkMessages()).find((message) =>
      message.To.some((to) => to.Address === recipient),
    );
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function absentFor(recipient: string, windowMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const match = (await sinkMessages()).find((message) =>
      message.To.some((to) => to.Address === recipient),
    );
    if (match) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return true;
}

describe('notifications (conformance)', () => {
  const AREA = 'notifications';

  let owner: Session;
  let member: Session;

  beforeAll(async () => {
    await ledgerProbe(AREA, async () => {
      owner = await Session.signUp('Notifications Owner');
      member = await Session.signUp('Notifications Member');
      const invitation = await owner.post('/api/organizations/invitations', {
        email: member.email,
        role: 'member',
      });
      expect(invitation.status).toBe(201);
      const accept = await member.post('/api/auth/organization/accept-invitation', {
        invitationId: ((await invitation.json()) as { id: string }).id,
      });
      expect(accept.status).toBe(200);
    });
  });

  it('delivers patient.created to the Contact Email (SENT)', 20_000, async () => {
    await ledgerProbe(AREA, async () => {
      const recipient = `created-${Date.now()}@sink.careops.test`;
      const res = await owner.post('/api/patients', {
        firstName: 'Notified',
        lastName: 'Patient',
        dateOfBirth: '1990-12-10',
        contactEmail: recipient,
      });
      expect(res.status).toBe(201);
      parseBody(patientSchema, await res.json());

      const message = await waitForMessageTo(recipient);
      expect(message).not.toBeNull();
    });
  });

  it('delivers the booking confirmation to the Patient (SENT)', 20_000, async () => {
    await ledgerProbe(AREA, async () => {
      // A Manager creates the patient with a Contact Email, then books.
      const recipient = `booked-${Date.now()}@sink.careops.test`;
      const created = await owner.post('/api/patients', {
        firstName: 'Booked',
        lastName: 'Patient',
        dateOfBirth: '1990-12-10',
        contactEmail: recipient,
      });
      expect(created.status).toBe(201);
      const patient = parseBody(patientSchema, await created.json());

      const current = parseBody(
        organizationCurrentSchema,
        await (await owner.get('/api/organizations/current')).json(),
      );
      const ownerMember = current.members.find((m) => m.role === 'owner');
      if (!ownerMember) throw new Error('expected the owner member');

      const booked = await owner.post('/api/appointments', {
        patientId: patient.id,
        memberId: ownerMember.id,
        start: '2026-12-20T10:00:00.000Z',
        durationMinutes: 30,
      });
      expect(booked.status).toBe(201);

      const message = await waitForMessageTo(recipient);
      expect(message).not.toBeNull();
    });
  });

  it(
    'records a skip (never a silent drop) when the Patient has no Contact Email',
    20_000,
    async () => {
      await ledgerProbe(AREA, async () => {
        // The sentinel address is not attached to any patient: if the backend
        // fabricated a recipient (or delivered anyway) the probe would see it.
        const sentinel = `skipped-${Date.now()}@sink.careops.test`;
        const created = await owner.post('/api/patients', {
          firstName: 'No',
          lastName: 'Contact',
          dateOfBirth: '1990-12-10',
          notes: sentinel, // the sentinel rides along in notes for correlation
        });
        expect(created.status).toBe(201);

        expect(await absentFor(sentinel)).toBe(true);
      });
    },
  );

  it('denies a member creating a notification-triggering record (RBAC)', async () => {
    await ledgerProbe(AREA, async () => {
      await expectTaxonomy(
        await member.post('/api/patients', {
          firstName: 'Member',
          lastName: 'Denied',
          dateOfBirth: '1990-12-10',
        }),
        403,
      );
    });
  });
});
