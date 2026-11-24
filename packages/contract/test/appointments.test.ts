// Appointments conformance cases (Go-T08) — ported from the reference API's
// appointments e2e suite. Same meanings, black-box seam: booking and the
// Conflict rule, the full lifecycle transition matrix, Reschedule semantics
// (self-exclusion, provider change, freed slots), slot freeing, tenancy, and
// the audit trail through the API. The three source expectations that read
// the datastore directly are ported through the audit listing endpoint, and
// the two Mongo-shaped id assertions are ported backend-neutrally: a
// well-formed but absent id is derived by flipping one character of a real
// id, so "missing is 404, malformed is 400" holds on any id scheme.
import { beforeAll, describe, expect, it } from 'bun:test';
import {
  appointmentSchema,
  appointmentStatusSchema,
  appointmentsPageSchema,
  auditEntriesPageSchema,
  organizationCurrentSchema,
  patientSchema,
  workspaceMeSchema,
  type Appointment,
  type AppointmentStatus,
} from '@careops/shared';
import { expectTaxonomy, ledgerProbe, parseBody, Session } from './helpers.js';

// Fixed future slots — appointments carry no past constraint (only Patient
// dateOfBirth does), so absolute dates keep the spec date-independent.
const SLOT_A = '2026-12-01T10:00:00.000Z'; // 10:00–10:30
const SLOT_A_B = '2026-12-01T10:30:00.000Z'; // back-to-back, 10:30–11:00
const SLOT_ELEVEN = '2026-12-01T11:00:00.000Z';
const SLOT_LATER = '2026-12-01T14:00:00.000Z';

const validPatient = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  dateOfBirth: '1990-12-10',
};

// Transcribed independently from the transition table so the suite checks
// the API against the spec, not against the implementation.
const EXPECTED_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  SCHEDULED: ['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

// Shortest legal path from SCHEDULED to each state (walk-in shortcuts
// included) — used to set up a source state for the matrix.
const DRIVE_PATH: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  SCHEDULED: [],
  CONFIRMED: ['CONFIRMED'],
  CHECKED_IN: ['CHECKED_IN'],
  IN_PROGRESS: ['CHECKED_IN', 'IN_PROGRESS'],
  COMPLETED: ['CHECKED_IN', 'COMPLETED'],
  CANCELLED: ['CANCELLED'],
  NO_SHOW: ['NO_SHOW'],
};

function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/** A well-formed but (almost surely) absent id in the backend's own scheme. */
function absentIdLike(realId: string): string {
  const first = realId[0] ?? 'f';
  return (first === '0' ? '1' : '0') + realId.slice(1);
}

describe('appointments (conformance)', () => {
  const AREA = 'appointments';

  let owner: Session;
  let member: Session;
  let stranger: Session;
  let patientId = '';
  let ownerMemberId = '';
  let memberMemberId = '';

  const book = (session: Session, body: Record<string, unknown>) =>
    session.post('/api/appointments', body);
  const transition = (session: Session, appointmentId: string, status: string) =>
    session.post(`/api/appointments/${appointmentId}/status`, { status });
  const reschedule = (session: Session, appointmentId: string, body: Record<string, unknown>) =>
    session.patch(`/api/appointments/${appointmentId}`, body);

  // Lifecycle tests book many appointments; a monotonic 30-minute slot
  // generator keeps every booking conflict-free by construction.
  let slotCounter = 0;
  const nextSlot = () => {
    const start = new Date(Date.parse('2026-12-03T00:00:00.000Z') + slotCounter * 30 * 60_000);
    slotCounter += 1;
    return start.toISOString();
  };

  const bookFresh = async (): Promise<Appointment> => {
    const res = await book(owner, {
      patientId,
      memberId: ownerMemberId,
      start: nextSlot(),
      durationMinutes: 30,
    });
    expect(res.status).toBe(201);
    return parseBody(appointmentSchema, await res.json());
  };

  const driveTo = async (appointmentId: string, status: AppointmentStatus) => {
    for (const step of DRIVE_PATH[status]) {
      expect((await transition(owner, appointmentId, step)).status).toBe(200);
    }
  };

  beforeAll(async () => {
    await ledgerProbe(AREA, async () => {
      owner = await Session.signUp('Appointments Owner');
      member = await Session.signUp('Appointments Member');
      stranger = await Session.signUp('Appointments Stranger');

      // Member joins the owner's organization via the invitation flow.
      const me = parseBody(workspaceMeSchema, await (await owner.me()).json());
      const invitation = await owner.post('/api/organizations/invitations', {
        email: member.email,
        role: 'member',
      });
      expect(invitation.status).toBe(201);
      const invitationId = ((await invitation.json()) as { id: string }).id;
      expect(
        (await member.post('/api/auth/organization/accept-invitation', { invitationId })).status,
      ).toBe(200);
      expect(
        (
          await member.post('/api/auth/organization/set-active', {
            organizationId: me.organization.id,
          })
        ).status,
      ).toBe(200);

      const patientRes = await owner.post('/api/patients', validPatient);
      expect(patientRes.status).toBe(201);
      patientId = parseBody(patientSchema, await patientRes.json()).id;

      // Provider ids from the API's own member surface — the exact ids the
      // booking endpoint resolves against (opaque by contract).
      const current = parseBody(
        organizationCurrentSchema,
        await (await owner.get('/api/organizations/current')).json(),
      );
      if (current.id !== me.organization.id) {
        throw new Error('organization surface does not match the active org');
      }
      const ownerMember = current.members.find((m) => m.role === 'owner');
      const memberMember = current.members.find((m) => m.role === 'member');
      if (!ownerMember || !memberMember) {
        throw new Error('expected one owner and one member in the seeded organization');
      }
      ownerMemberId = ownerMember.id;
      memberMemberId = memberMember.id;
    });
  });

  describe('booking', () => {
    it('books an appointment: SCHEDULED, Z-normalized start', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await book(owner, {
          patientId,
          memberId: ownerMemberId,
          start: SLOT_A,
          durationMinutes: 30,
          notes: 'first booking',
        });
        expect(res.status).toBe(201);
        const appointment = parseBody(appointmentSchema, await res.json());
        expect(appointment.status).toBe('SCHEDULED');
        expect(appointment.start).toBe(SLOT_A);
        expect(appointment.durationMinutes).toBe(30);
        expect(appointment.organizationId).not.toBe('');
      });
    });

    it('normalizes an offset start to UTC Z-form', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await book(owner, {
          patientId,
          memberId: memberMemberId,
          start: '2026-12-02T12:00:00.000+02:00', // == 10:00Z
          durationMinutes: 30,
        });
        expect(res.status).toBe(201);
        expect(parseBody(appointmentSchema, await res.json()).start).toBe(
          '2026-12-02T10:00:00.000Z',
        );
      });
    });

    it('rejects an overlapping slot with a hard 409 in the shared taxonomy', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await book(owner, {
          patientId,
          memberId: ownerMemberId,
          start: SLOT_A,
          durationMinutes: 30,
        });
        const parsed = await expectTaxonomy(res, 409);
        expect(parsed.message).toMatch(/overlap/i);
      });
    });

    it('allows back-to-back slots for the same provider', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await book(owner, {
          patientId,
          memberId: ownerMemberId,
          start: SLOT_A_B,
          durationMinutes: 30,
        });
        expect(res.status).toBe(201);
      });
    });

    it('allows the same slot for a different provider', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await book(owner, {
          patientId,
          memberId: memberMemberId,
          start: SLOT_A,
          durationMinutes: 30,
        });
        expect(res.status).toBe(201);
      });
    });

    it('only one of two concurrent bookings of the same slot wins', async () => {
      await ledgerProbe(AREA, async () => {
        const body = { patientId, memberId: ownerMemberId, start: SLOT_LATER, durationMinutes: 30 };
        const [first, second] = await Promise.all([book(owner, body), book(owner, body)]);
        const statuses = [first.status, second.status].sort();
        expect(statuses).toEqual([201, 409]);
      });
    });

    it('rejects malformed bookings with 400 field errors', async () => {
      await ledgerProbe(AREA, async () => {
        const badStart = await book(owner, {
          patientId,
          memberId: ownerMemberId,
          start: 'not-a-datetime',
          durationMinutes: 30,
        });
        expect(badStart.status).toBe(400);
        expect((await expectTaxonomy(badStart, 400)).errors.length).toBeGreaterThan(0);

        for (const patch of [
          { durationMinutes: 10 },
          { durationMinutes: 500 },
          { patientId: 'nothex' },
        ]) {
          const res = await book(owner, {
            patientId,
            memberId: ownerMemberId,
            start: nextSlot(),
            durationMinutes: 30,
            ...patch,
          });
          expect(res.status).toBe(400);
        }
      });
    });

    it('is 404 when the referenced patient or provider does not exist here', async () => {
      await ledgerProbe(AREA, async () => {
        const missingPatient = absentIdLike(patientId);
        expect(
          (
            await book(owner, {
              patientId: missingPatient,
              memberId: ownerMemberId,
              start: nextSlot(),
              durationMinutes: 30,
            })
          ).status,
        ).toBe(404);
        const missingMember = absentIdLike(ownerMemberId);
        expect(
          (
            await book(owner, {
              patientId,
              memberId: missingMember,
              start: nextSlot(),
              durationMinutes: 30,
            })
          ).status,
        ).toBe(404);
      });
    });

    it('denies a member booking (RBAC) but allows them to read', async () => {
      await ledgerProbe(AREA, async () => {
        expect(
          (
            await book(member, {
              patientId,
              memberId: memberMemberId,
              start: nextSlot(),
              durationMinutes: 30,
            })
          ).status,
        ).toBe(403);
        expect((await member.get('/api/appointments')).status).toBe(200);
      });
    });
  });

  describe('reading', () => {
    it('fetches one appointment', async () => {
      await ledgerProbe(AREA, async () => {
        const page = parseBody(
          appointmentsPageSchema,
          await (await owner.get('/api/appointments?limit=1')).json(),
        );
        const first = page.items[0];
        if (!first) throw new Error('expected at least one appointment');
        const res = await owner.get(`/api/appointments/${first.id}`);
        expect(res.status).toBe(200);
        expect(parseBody(appointmentSchema, await res.json()).id).toBe(first.id);
      });
    });

    it('is 404-not-403 for another organization', async () => {
      await ledgerProbe(AREA, async () => {
        const page = parseBody(
          appointmentsPageSchema,
          await (await owner.get('/api/appointments?limit=1')).json(),
        );
        const someId = page.items[0]?.id;
        if (!someId) throw new Error('expected at least one appointment');
        await expectTaxonomy(await stranger.get(`/api/appointments/${someId}`), 404);
      });
    });

    it('another organization sees none of our appointments in lists', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await stranger.get('/api/appointments');
        expect(res.status).toBe(200);
        expect(parseBody(appointmentsPageSchema, await res.json()).items).toHaveLength(0);
      });
    });

    it('paginates newest-first with non-overlapping cursor pages', async () => {
      await ledgerProbe(AREA, async () => {
        const first = parseBody(
          appointmentsPageSchema,
          await (await owner.get('/api/appointments?limit=2')).json(),
        );
        expect(first.items).toHaveLength(2);
        expect(first.hasMore).toBe(true);
        const second = parseBody(
          appointmentsPageSchema,
          await (await owner.get(`/api/appointments?limit=2&cursor=${first.nextCursor}`)).json(),
        );
        const firstIds = first.items.map((a) => a.id);
        const secondIds = second.items.map((a) => a.id);
        expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
      });
    });

    it('filters by status, provider, and start window', async () => {
      await ledgerProbe(AREA, async () => {
        const scheduled = parseBody(
          appointmentsPageSchema,
          await (await owner.get('/api/appointments?status=SCHEDULED')).json(),
        );
        expect(scheduled.items.every((a) => a.status === 'SCHEDULED')).toBe(true);

        const byProvider = parseBody(
          appointmentsPageSchema,
          await (await owner.get(`/api/appointments?memberId=${memberMemberId}`)).json(),
        );
        expect(byProvider.items.length).toBeGreaterThanOrEqual(2);
        expect(byProvider.items.every((a) => a.memberId === memberMemberId)).toBe(true);

        const windowed = parseBody(
          appointmentsPageSchema,
          await (
            await owner.get(
              '/api/appointments?from=2026-12-01T09:00:00.000Z&to=2026-12-01T11:00:00.000Z',
            )
          ).json(),
        );
        expect(windowed.items.length).toBeGreaterThanOrEqual(2);
        expect(
          windowed.items.every(
            (a) => a.start >= '2026-12-01T09:00:00.000Z' && a.start <= '2026-12-01T11:00:00.000Z',
          ),
        ).toBe(true);

        const empty = parseBody(
          appointmentsPageSchema,
          await (
            await owner.get(
              '/api/appointments?from=2026-12-01T11:01:00.000Z&to=2026-12-01T12:00:00.000Z',
            )
          ).json(),
        );
        expect(empty.items).toHaveLength(0);
      });
    });

    it('rejects malformed filters with 400s', async () => {
      await ledgerProbe(AREA, async () => {
        expect((await owner.get('/api/appointments?status=RESCHEDULED')).status).toBe(400);
        expect((await owner.get('/api/appointments?cursor=zzz')).status).toBe(400);
        expect(
          (
            await owner.get(
              '/api/appointments?from=2026-12-01T11:00:00.000Z&to=2026-12-01T09:00:00.000Z',
            )
          ).status,
        ).toBe(400);
      });
    });
  });

  describe('lifecycle transitions', () => {
    it('walks the happy path SCHEDULED→CONFIRMED→CHECKED_IN→IN_PROGRESS→COMPLETED', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        for (const step of ['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'] as const) {
          const res = await transition(owner, appointment.id, step);
          expect(res.status).toBe(200);
          expect(parseBody(appointmentSchema, await res.json()).status).toBe(step);
        }
      });
    });

    it('accepts a walk-in: SCHEDULED→CHECKED_IN directly', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        const res = await transition(owner, appointment.id, 'CHECKED_IN');
        expect(res.status).toBe(200);
        expect(parseBody(appointmentSchema, await res.json()).status).toBe('CHECKED_IN');
      });
    });

    it('enforces the full matrix: allowed edges 200, forbidden pairs 409 naming the targets', async () => {
      await ledgerProbe(AREA, async () => {
        for (const from of appointmentStatusSchema.options) {
          for (const to of appointmentStatusSchema.options) {
            const appointment = await bookFresh();
            await driveTo(appointment.id, from);
            const res = await transition(owner, appointment.id, to);
            const allowed = EXPECTED_TRANSITIONS[from];
            if (allowed.includes(to)) {
              expect(res.status).toBe(200);
              expect(parseBody(appointmentSchema, await res.json()).status).toBe(to);
            } else {
              const parsed = await expectTaxonomy(res, 409);
              expect(parsed.errors[0]?.field).toBe('status');
              const named = parsed.errors[0]?.message ?? '';
              if (allowed.length === 0) {
                expect(named).toMatch(/none/i);
              } else {
                for (const target of allowed) {
                  expect(named).toContain(target);
                }
              }
            }
          }
        }
      });
    });

    it('rejects an unknown target status or an empty body with 400', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        expect((await transition(owner, appointment.id, 'RESCHEDULED')).status).toBe(400);
        expect((await owner.post(`/api/appointments/${appointment.id}/status`, {})).status).toBe(
          400,
        );
      });
    });

    it('denies a member transitions and reschedules (RBAC) but allows reads', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        expect((await transition(member, appointment.id, 'CONFIRMED')).status).toBe(403);
        expect((await reschedule(member, appointment.id, { start: nextSlot() })).status).toBe(403);
        expect((await member.get(`/api/appointments/${appointment.id}`)).status).toBe(200);
      });
    });

    it('is 404-not-403 for another organization on both mutations', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        expect((await transition(stranger, appointment.id, 'CONFIRMED')).status).toBe(404);
        expect((await reschedule(stranger, appointment.id, { start: nextSlot() })).status).toBe(
          404,
        );
      });
    });

    it('is 404 for a missing appointment on both mutations', async () => {
      await ledgerProbe(AREA, async () => {
        const missing = absentIdLike((await bookFresh()).id);
        expect((await transition(owner, missing, 'CONFIRMED')).status).toBe(404);
        expect((await reschedule(owner, missing, { start: nextSlot() })).status).toBe(404);
      });
    });
  });

  describe('reschedule', () => {
    it('moves the start from SCHEDULED and re-derives the conflict window', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        const newStart = '2026-12-06T09:00:00.000Z';
        const res = await reschedule(owner, appointment.id, { start: newStart });
        expect(res.status).toBe(200);
        const moved = parseBody(appointmentSchema, await res.json());
        expect(moved.start).toBe(newStart);
        expect(moved.status).toBe('SCHEDULED');
        expect(moved.durationMinutes).toBe(30);
        // The moved appointment now holds [09:00, 09:30): an overlapping probe
        // conflicts, a back-to-back probe books.
        expect(
          (
            await book(owner, {
              patientId,
              memberId: ownerMemberId,
              start: '2026-12-06T09:15:00.000Z',
              durationMinutes: 30,
            })
          ).status,
        ).toBe(409);
        expect(
          (
            await book(owner, {
              patientId,
              memberId: ownerMemberId,
              start: '2026-12-06T09:30:00.000Z',
              durationMinutes: 30,
            })
          ).status,
        ).toBe(201);
      });
    });

    it('reschedules from CONFIRMED, keeping the state', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        expect((await transition(owner, appointment.id, 'CONFIRMED')).status).toBe(200);
        const res = await reschedule(owner, appointment.id, { start: '2026-12-06T13:00:00.000Z' });
        expect(res.status).toBe(200);
        const moved = parseBody(appointmentSchema, await res.json());
        expect(moved.start).toBe('2026-12-06T13:00:00.000Z');
        expect(moved.status).toBe('CONFIRMED');
      });
    });

    it('changes the provider, freeing the old provider’s slot', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        const res = await reschedule(owner, appointment.id, { memberId: memberMemberId });
        expect(res.status).toBe(200);
        const moved = parseBody(appointmentSchema, await res.json());
        expect(moved.memberId).toBe(memberMemberId);
        expect(moved.start).toBe(appointment.start);
        // The old provider is free at that time again; the new provider holds it.
        expect(
          (
            await book(owner, {
              patientId,
              memberId: ownerMemberId,
              start: appointment.start,
              durationMinutes: 30,
            })
          ).status,
        ).toBe(201);
        expect(
          (
            await book(owner, {
              patientId,
              memberId: memberMemberId,
              start: appointment.start,
              durationMinutes: 30,
            })
          ).status,
        ).toBe(409);
      });
    });

    it('extends the duration over its own old slot (self-exclusion)', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        // The extended 60-minute window also holds the next 30-minute slot;
        // skip it so later bookFresh calls stay conflict-free.
        nextSlot();
        const res = await reschedule(owner, appointment.id, { durationMinutes: 60 });
        expect(res.status).toBe(200);
        const extended = parseBody(appointmentSchema, await res.json());
        expect(extended.durationMinutes).toBe(60);
        expect(extended.start).toBe(appointment.start);
        // The extra half hour is now held: a probe inside it conflicts.
        expect(
          (
            await book(owner, {
              patientId,
              memberId: ownerMemberId,
              start: plusMinutes(appointment.start, 45),
              durationMinutes: 30,
            })
          ).status,
        ).toBe(409);
      });
    });

    it('rejects an overlapping move with 409 and leaves the appointment unchanged', async () => {
      await ledgerProbe(AREA, async () => {
        const first = await bookFresh();
        const second = await bookFresh();
        const res = await reschedule(owner, first.id, { start: second.start });
        expect(res.status).toBe(409);
        expect((await expectTaxonomy(res, 409)).message).toMatch(/overlap/i);
        const unchanged = parseBody(
          appointmentSchema,
          await (await owner.get(`/api/appointments/${first.id}`)).json(),
        );
        expect(unchanged.start).toBe(first.start);
        expect(unchanged.status).toBe('SCHEDULED');
      });
    });

    it('rejects reschedules from every later state with 409', async () => {
      await ledgerProbe(AREA, async () => {
        for (const status of [
          'CHECKED_IN',
          'IN_PROGRESS',
          'COMPLETED',
          'CANCELLED',
          'NO_SHOW',
        ] as const) {
          const appointment = await bookFresh();
          await driveTo(appointment.id, status);
          const res = await reschedule(owner, appointment.id, { start: nextSlot() });
          expect(res.status).toBe(409);
          const parsed = await expectTaxonomy(res, 409);
          expect(parsed.message).toMatch(/reschedule/i);
          expect(parsed.errors[0]?.field).toBe('status');
          const unchanged = parseBody(
            appointmentSchema,
            await (await owner.get(`/api/appointments/${appointment.id}`)).json(),
          );
          expect(unchanged.start).toBe(appointment.start);
        }
      });
    });

    it('rejects malformed patches with 400 field errors', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        const empty = await reschedule(owner, appointment.id, {});
        expect(empty.status).toBe(400);
        const emptyErrors = (await expectTaxonomy(empty, 400)).errors;
        expect(emptyErrors.some((error) => /at least one/i.test(error.message))).toBe(true);
        expect((await reschedule(owner, appointment.id, { durationMinutes: 10 })).status).toBe(400);
        expect((await reschedule(owner, appointment.id, { durationMinutes: 500 })).status).toBe(
          400,
        );
        expect((await reschedule(owner, appointment.id, { start: 'not-a-datetime' })).status).toBe(
          400,
        );
        expect((await reschedule(owner, appointment.id, { memberId: '' })).status).toBe(400);
      });
    });

    it('is 404 when the target provider does not exist in this organization', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        const missingMember = absentIdLike(memberMemberId);
        expect((await reschedule(owner, appointment.id, { memberId: missingMember })).status).toBe(
          404,
        );
      });
    });
  });

  describe('slot freeing', () => {
    it('a CANCELLED appointment no longer holds its slot', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        expect((await transition(owner, appointment.id, 'CANCELLED')).status).toBe(200);
        expect(
          (
            await book(owner, {
              patientId,
              memberId: ownerMemberId,
              start: appointment.start,
              durationMinutes: 30,
            })
          ).status,
        ).toBe(201);
      });
    });

    it('a NO_SHOW appointment no longer holds its slot', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        expect((await transition(owner, appointment.id, 'NO_SHOW')).status).toBe(200);
        expect(
          (
            await book(owner, {
              patientId,
              memberId: ownerMemberId,
              start: appointment.start,
              durationMinutes: 30,
            })
          ).status,
        ).toBe(201);
      });
    });
  });

  describe('audit trail (through the API)', () => {
    const entriesFor = async (appointment: Appointment) => {
      const page = parseBody(
        auditEntriesPageSchema,
        await (await owner.get('/api/audit-entries?limit=100')).json(),
      );
      return page.items.filter(
        (entry) => entry.entity === 'appointment' && entry.entityId === appointment.id,
      );
    };

    it('a booking wrote a create entry with null before-state', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await book(owner, {
          patientId,
          memberId: ownerMemberId,
          start: SLOT_ELEVEN,
          durationMinutes: 30,
        });
        expect(res.status).toBe(201);
        const appointment = parseBody(appointmentSchema, await res.json());
        const entries = await entriesFor(appointment);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.actorEmail).toBe(owner.email);
        expect(entries[0]?.action).toBe('create');
        expect(entries[0]?.before).toBeNull();
      });
    });

    it('a transition wrote an update entry with before→after status', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        expect((await transition(owner, appointment.id, 'CONFIRMED')).status).toBe(200);
        const entries = await entriesFor(appointment);
        expect(entries).toHaveLength(2);
        const update = entries.find((entry) => entry.action === 'update');
        expect(update?.actorEmail).toBe(owner.email);
        const before = parseBody(appointmentSchema, update?.before);
        const after = parseBody(appointmentSchema, update?.after);
        expect(before.status).toBe('SCHEDULED');
        expect(after.status).toBe('CONFIRMED');
      });
    });

    it('a reschedule wrote an update entry with before→after start', async () => {
      await ledgerProbe(AREA, async () => {
        const appointment = await bookFresh();
        const newStart = nextSlot();
        expect((await reschedule(owner, appointment.id, { start: newStart })).status).toBe(200);
        const entries = await entriesFor(appointment);
        expect(entries).toHaveLength(2);
        const update = entries.find((entry) => entry.action === 'update');
        expect(update?.actorEmail).toBe(owner.email);
        const before = parseBody(appointmentSchema, update?.before);
        const after = parseBody(appointmentSchema, update?.after);
        expect(before.start).toBe(appointment.start);
        expect(after.start).toBe(newStart);
      });
    });
  });
});
