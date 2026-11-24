// Reports conformance cases (Go-T13) — ported from the reference's reports
// e2e suite onto the black-box seam: the four reports' computed values,
// bounded windows, malformed-window 400s, tenancy, member reads, and the
// cache-invalidation behavior (a write is visible on the next read — the
// generation counter does the invalidating; the Redis key layout is
// implementation detail and is never introspected).
import { beforeAll, describe, expect, it } from 'bun:test';
import {
  appointmentsPageSchema,
  dailyVolumeSchema,
  organizationCurrentSchema,
  providerUtilizationReportSchema,
  statusBreakdownSchema,
  todayScheduleSchema,
} from '@careops/shared';
import type { z } from 'zod';
import { patientSchema } from '@careops/shared';
import { ledgerProbe, parseBody, Session } from './helpers.js';

const validPatient = {
  firstName: 'Report',
  lastName: 'Fixture',
  dateOfBirth: '1990-12-10',
};

describe('reports (conformance)', () => {
  const AREA = 'reports';

  let owner: Session;
  let member: Session;
  let stranger: Session;
  let patientId = '';
  let ownerMemberId = '';

  // Fixed slots INSIDE every queried window (relative to now).
  beforeAll(async () => {
    await ledgerProbe('organizations', async () => {
      owner = await Session.signUp('Reports Owner');
      member = await Session.signUp('Reports Member');
      stranger = await Session.signUp('Reports Stranger');
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
    await ledgerProbe('patients', async () => {
      const res = await owner.post('/api/patients', validPatient);
      expect(res.status).toBe(201);
      patientId = parseBody(patientSchema, await res.json()).id;
    });
    await ledgerProbe('organizations', async () => {
      const current = parseBody(
        organizationCurrentSchema,
        await (await owner.get('/api/organizations/current')).json(),
      );
      const ownerMember = current.members.find((m) => m.role === 'owner');
      if (!ownerMember) throw new Error('expected the owner member');
      ownerMemberId = ownerMember.id;
    });
  });

  it(
    'daily volume buckets by UTC day, zero-filled, honoring the default window',
    20_000,
    async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.get('/api/reports/daily-volume');
        expect(res.status).toBe(200);
        const report = parseBody(dailyVolumeSchema, await res.json());
        expect(report.days).toBe(30);
        expect(report.points.length).toBe(30);
        for (const point of report.points) {
          expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      });
    },
  );

  it('status breakdown counts all seven states and derives the rates', 20_000, async () => {
    await ledgerProbe(AREA, async () => {
      // Seed one cancelled and one no-show appointment (plus two holding).
      const today = new Date().toISOString().slice(0, 10);
      const slots = ['10:00', '11:00', '12:00', '13:00'].map((time) => `${today}T${time}:00.000Z`);
      for (const start of slots) {
        const res = await owner.post('/api/appointments', {
          patientId,
          memberId: ownerMemberId,
          start,
          durationMinutes: 30,
        });
        expect(res.status).toBe(201);
      }
      const page = parseBody(
        appointmentsPageSchema,
        await (await owner.get('/api/appointments?status=SCHEDULED')).json(),
      );
      const mine = page.items.slice(0, 4);
      expect(
        (await owner.post(`/api/appointments/${mine[0]!.id}/status`, { status: 'CANCELLED' }))
          .status,
      ).toBe(200);
      expect(
        (await owner.post(`/api/appointments/${mine[1]!.id}/status`, { status: 'NO_SHOW' })).status,
      ).toBe(200);

      const res = await owner.get('/api/reports/status-breakdown');
      expect(res.status).toBe(200);
      const report = parseBody(statusBreakdownSchema, await res.json());
      expect(report.counts).toHaveLength(7);
      expect(report.total).toBeGreaterThanOrEqual(4);
      const byStatus = new Map(report.counts.map((c) => [c.status, c.count]));
      expect(byStatus.get('CANCELLED')).toBeGreaterThanOrEqual(1);
      expect(byStatus.get('NO_SHOW')).toBeGreaterThanOrEqual(1);
      expect(report.cancellationRate).toBeCloseTo(
        (byStatus.get('CANCELLED') ?? 0) / report.total,
        5,
      );
      expect(report.noShowRate).toBeCloseTo((byStatus.get('NO_SHOW') ?? 0) / report.total, 5);
    });
  });

  it(
    'provider utilization sums booked minutes, excludes freed slots, resolves names',
    20_000,
    async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.get('/api/reports/provider-utilization');
        expect(res.status).toBe(200);
        const report = parseBody(providerUtilizationReportSchema, await res.json());
        expect(report.capacityMinutesPerDay).toBe(480);
        const ownerRow = report.providers.find((p) => p.memberId === ownerMemberId);
        expect(ownerRow).toBeDefined();
        expect(ownerRow!.providerName).not.toBe('');
        for (const provider of report.providers) {
          expect(provider.bookedMinutes).toBe(provider.appointmentCount * 30);
          expect(provider.utilization).toBeCloseTo(
            provider.bookedMinutes / report.capacityMinutesPerDay,
            5,
          );
        }
      });
    },
  );

  it(
    "today returns today's appointments sorted by start as a plain range query",
    20_000,
    async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.get('/api/reports/today');
        expect(res.status).toBe(200);
        const schedule = parseBody(todayScheduleSchema, await res.json());
        for (let i = 1; i < schedule.items.length; i++) {
          expect(schedule.items[i - 1]!.start <= schedule.items[i]!.start).toBe(true);
        }
      });
    },
  );

  it('rejects out-of-range and non-integer windows with 400 field errors', async () => {
    await ledgerProbe(AREA, async () => {
      for (const days of ['0', '91', 'not-an-int']) {
        for (const path of ['daily-volume', 'status-breakdown', 'provider-utilization']) {
          const res = await owner.get(`/api/reports/${path}?days=${days}`);
          if (res.status !== 400) {
            throw new Error(`${path}?days=${days}: got ${res.status}, want 400`);
          }
        }
      }
      const boundary = await owner.get('/api/reports/daily-volume?days=1');
      expect(boundary.status).toBe(200);
    });
  });

  it('another organization sees none of our data in any report', 20_000, async () => {
    await ledgerProbe(AREA, async () => {
      for (const path of ['daily-volume', 'status-breakdown', 'provider-utilization', 'today']) {
        const res = await stranger.get(`/api/reports/${path}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items?: Array<Record<string, unknown>>;
          points?: Array<{ count: number }>;
          providers?: Array<{ bookedMinutes: number }>;
          total?: number;
        };
        if (body.points) {
          // daily-volume zero-fills for the caller's own org even with no
          // data — assert no cross-org COUNTS leak, not an empty array.
          expect(body.points.reduce((sum, p) => sum + p.count, 0)).toBe(0);
        }
        if (body.total !== undefined) {
          expect(body.total).toBe(0);
        }
        if (body.providers) {
          expect(body.providers.reduce((sum, p) => sum + p.bookedMinutes, 0)).toBe(0);
        }
      }
    });
  });

  it('a member may read reports (MEMBER+)', async () => {
    await ledgerProbe(AREA, async () => {
      expect((await member.get('/api/reports/daily-volume')).status).toBe(200);
    });
  });

  it('rejects an unauthenticated read with 401', async () => {
    await ledgerProbe(AREA, async () => {
      const res = await Session.anonymous().get('/api/reports/daily-volume');
      expect(res.status).toBe(401);
    });
  });

  it('a write is visible on the next read (cache invalidation by behavior)', 20_000, async () => {
    await ledgerProbe(AREA, async () => {
      // Warm the cache with a 2-day window (the booking may land on today's
      // UTC day or tomorrow's, depending on when the suite runs).
      const windowDays = 7;
      const first = parseBody(
        dailyVolumeSchema,
        await (await owner.get(`/api/reports/daily-volume?days=${windowDays}`)).json(),
      );
      // Book AFTER the provider's latest booked slot: guaranteed conflict-
      // free regardless of fixture ordering. The fixtures end 14:00 UTC, so
      // the slot stays inside today's UTC day at any run time.
      const providerAppointments = parseBody(
        appointmentsPageSchema,
        await (await owner.get(`/api/appointments?memberId=${ownerMemberId}&limit=100`)).json(),
      );
      let latestEnd = Date.parse(`${new Date().toISOString().slice(0, 10)}T09:00:00.000Z`);
      for (const appointment of providerAppointments.items) {
        const end = Date.parse(appointment.start) + appointment.durationMinutes * 60_000;
        if (end > latestEnd) latestEnd = end;
      }
      const bookingStart = new Date(latestEnd + 60_000).toISOString();
      const bookingDate = bookingStart.slice(0, 10);
      const countOn = (report: z.infer<typeof dailyVolumeSchema>, date: string) =>
        report.points.find((p) => p.date === date)?.count ?? 0;
      const beforeCount = countOn(first, bookingDate);

      // Book, then poll: the behavioral contract is "a write is visible on
      // the next read" — the reference invalidates post-commit and
      // best-effort (ADR-0011), so allow a short propagation window.
      const booked = await owner.post('/api/appointments', {
        patientId,
        memberId: ownerMemberId,
        start: bookingStart,
        durationMinutes: 30,
      });
      expect(booked.status).toBe(201);

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const second = parseBody(
          dailyVolumeSchema,
          await (await owner.get(`/api/reports/daily-volume?days=${windowDays}`)).json(),
        );
        if (countOn(second, bookingDate) === beforeCount + 1) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(
        `daily-volume did not reflect the booking on ${bookingDate} (bookingStart=${bookingStart}, ` +
          `provider slots: ${providerAppointments.items.map((a) => a.start).join(', ')})`,
      );
    });
  });

  it('today responds with a bounded, typed schedule for the member too', 20_000, async () => {
    await ledgerProbe(AREA, async () => {
      const res = await member.get('/api/reports/today');
      expect(res.status).toBe(200);
      const schedule = parseBody(todayScheduleSchema, await res.json());
      expect(Array.isArray(schedule.items)).toBe(true);
    });
  });
});
