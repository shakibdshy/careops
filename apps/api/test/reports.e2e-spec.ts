import request from 'supertest';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type Redis from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import {
  appointmentSchema,
  dailyVolumeSchema,
  errorResponseSchema,
  invitationSchema,
  organizationCurrentSchema,
  patientSchema,
  providerUtilizationReportSchema,
  statusBreakdownSchema,
  todayScheduleSchema,
  type DailyVolume,
} from '@careops/shared';
import { REDIS_CLIENT } from '../src/redis/redis.module.js';
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

const validPatient = { firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1990-12-10' };

const MS_PER_DAY = 86_400_000;

/** A UTC slot `daysAgo` days before today at `hour`:00 — reports window is relative to now. */
function dayAt(daysAgo: number, hour: number): string {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight - daysAgo * MS_PER_DAY + hour * 3_600_000).toISOString();
}

function countOn(report: DailyVolume, date: string): number {
  return report.points.find((point) => point.date === date)?.count ?? 0;
}

describe('Reports (e2e)', () => {
  let app: INestApplication<App>;
  let harness: E2eHarness;
  let ownerAgent: ReturnType<typeof request.agent>;
  let memberAgent: ReturnType<typeof request.agent>;
  let strangerAgent: ReturnType<typeof request.agent>;
  let patientId: string;
  let ownerMemberId: string;
  let memberMemberId: string;
  let ownerOrgId: string;
  let todayStr: string;
  let yesterdayStr: string;
  let threeDaysAgoStr: string;

  const book = async (body: Record<string, unknown>) => {
    const res = await ownerAgent.post('/api/appointments').send(body).expect(201);
    return appointmentSchema.parse(res.body);
  };
  const transition = (id: string, status: string) =>
    ownerAgent.post(`/api/appointments/${id}/status`).send({ status });

  beforeAll(async () => {
    harness = await setupE2eApp('careops-reports-test');
    app = harness.app;
    ownerAgent = request.agent(app.getHttpServer());
    memberAgent = request.agent(app.getHttpServer());
    strangerAgent = request.agent(app.getHttpServer());

    await ownerAgent.post('/api/auth/sign-up/email').send(OWNER).expect(200);
    await memberAgent.post('/api/auth/sign-up/email').send(MEMBER).expect(200);
    await strangerAgent.post('/api/auth/sign-up/email').send(STRANGER).expect(200);

    const meRes = await ownerAgent.get('/api/workspace/me').expect(200);
    ownerOrgId = (meRes.body as { organization: { id: string } }).organization.id;
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

    patientId = patientSchema.parse(
      (await ownerAgent.post('/api/patients').send(validPatient).expect(201)).body,
    ).id;

    const current = organizationCurrentSchema.parse(
      (await ownerAgent.get('/api/organizations/current').expect(200)).body,
    );
    const ownerMember = current.members.find((m) => m.role === 'owner');
    const memberMember = current.members.find((m) => m.role === 'member');
    if (!ownerMember || !memberMember) {
      throw new Error('Expected one owner and one member in the seeded organization');
    }
    ownerMemberId = ownerMember.id;
    memberMemberId = memberMember.id;

    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    todayStr = new Date(midnight).toISOString().slice(0, 10);
    yesterdayStr = new Date(midnight - MS_PER_DAY).toISOString().slice(0, 10);
    threeDaysAgoStr = new Date(midnight - 3 * MS_PER_DAY).toISOString().slice(0, 10);

    // Fixture: 6 appointments inside the trailing 30-day window + 1 outside.
    // Owner: today SCHEDULED + today COMPLETED, yesterday CANCELLED, 3d ago
    // NO_SHOW, 40d ago SCHEDULED (outside). Member: today 60m SCHEDULED,
    // yesterday CONFIRMED.
    await book({ patientId, memberId: ownerMemberId, start: dayAt(0, 9), durationMinutes: 30 });
    const completed = await book({
      patientId,
      memberId: ownerMemberId,
      start: dayAt(0, 10),
      durationMinutes: 30,
    });
    await transition(completed.id, 'CHECKED_IN').expect(200);
    await transition(completed.id, 'COMPLETED').expect(200);
    const cancelled = await book({
      patientId,
      memberId: ownerMemberId,
      start: dayAt(1, 9),
      durationMinutes: 30,
    });
    await transition(cancelled.id, 'CANCELLED').expect(200);
    const noShow = await book({
      patientId,
      memberId: ownerMemberId,
      start: dayAt(3, 9),
      durationMinutes: 30,
    });
    await transition(noShow.id, 'NO_SHOW').expect(200);
    await book({ patientId, memberId: ownerMemberId, start: dayAt(40, 9), durationMinutes: 30 });
    await book({ patientId, memberId: memberMemberId, start: dayAt(0, 11), durationMinutes: 60 });
    const confirmed = await book({
      patientId,
      memberId: memberMemberId,
      start: dayAt(1, 10),
      durationMinutes: 30,
    });
    await transition(confirmed.id, 'CONFIRMED').expect(200);
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('daily-volume', () => {
    it('buckets counts by UTC day, zero-filled, excluding the out-of-window appointment', async () => {
      const report = dailyVolumeSchema.parse(
        (await ownerAgent.get('/api/reports/daily-volume?days=30').expect(200)).body,
      );
      expect(report.days).toBe(30);
      expect(report.points).toHaveLength(30);
      expect(countOn(report, todayStr)).toBe(3);
      expect(countOn(report, yesterdayStr)).toBe(2);
      expect(countOn(report, threeDaysAgoStr)).toBe(1);
      expect(report.points.reduce((sum, point) => sum + point.count, 0)).toBe(6);
      expect(report.points.at(-1)?.date).toBe(todayStr);
    });

    it('defaults to a 30-day window when days is omitted', async () => {
      const report = dailyVolumeSchema.parse(
        (await ownerAgent.get('/api/reports/daily-volume').expect(200)).body,
      );
      expect(report.days).toBe(30);
      expect(report.points).toHaveLength(30);
    });

    it('honors a 1-day window (today only)', async () => {
      const report = dailyVolumeSchema.parse(
        (await ownerAgent.get('/api/reports/daily-volume?days=1').expect(200)).body,
      );
      expect(report.points).toHaveLength(1);
      expect(countOn(report, todayStr)).toBe(3);
    });
  });

  describe('status-breakdown', () => {
    it('counts all seven states and derives cancellation/No-Show rates', async () => {
      const report = statusBreakdownSchema.parse(
        (await ownerAgent.get('/api/reports/status-breakdown?days=30').expect(200)).body,
      );
      expect(report.total).toBe(6);
      const byStatus = new Map(report.counts.map((entry) => [entry.status, entry.count]));
      expect(byStatus.get('SCHEDULED')).toBe(2);
      expect(byStatus.get('CONFIRMED')).toBe(1);
      expect(byStatus.get('COMPLETED')).toBe(1);
      expect(byStatus.get('CANCELLED')).toBe(1);
      expect(byStatus.get('NO_SHOW')).toBe(1);
      expect(byStatus.get('CHECKED_IN')).toBe(0);
      expect(byStatus.get('IN_PROGRESS')).toBe(0);
      expect(report.counts).toHaveLength(7);
      expect(report.cancellationRate).toBeCloseTo(1 / 6, 10);
      expect(report.noShowRate).toBeCloseTo(1 / 6, 10);
    });
  });

  describe('provider-utilization', () => {
    it('sums booked minutes per Provider, excludes freed slots, resolves names via $lookup', async () => {
      const report = providerUtilizationReportSchema.parse(
        (await ownerAgent.get('/api/reports/provider-utilization?days=30').expect(200)).body,
      );
      expect(report.capacityMinutesPerDay).toBe(480);
      expect(report.providers).toHaveLength(2);
      // Sorted by booked minutes desc: Member 90 (60+30), Owner 60 (30+30,
      // cancelled/no-show/out-of-window excluded).
      expect(report.providers[0]?.memberId).toBe(memberMemberId);
      expect(report.providers[0]?.providerName).toBe(MEMBER.name);
      expect(report.providers[0]?.bookedMinutes).toBe(90);
      expect(report.providers[0]?.appointmentCount).toBe(2);
      expect(report.providers[0]?.utilization).toBeCloseTo(90 / 480, 10);
      expect(report.providers[1]?.memberId).toBe(ownerMemberId);
      expect(report.providers[1]?.providerName).toBe(OWNER.name);
      expect(report.providers[1]?.bookedMinutes).toBe(60);
      expect(report.providers[1]?.utilization).toBeCloseTo(60 / 480, 10);
    });

    it('utilization is independent of the window length (days=1)', async () => {
      const report = providerUtilizationReportSchema.parse(
        (await ownerAgent.get('/api/reports/provider-utilization?days=1').expect(200)).body,
      );
      const owner = report.providers.find((p) => p.memberId === ownerMemberId);
      const member = report.providers.find((p) => p.memberId === memberMemberId);
      expect(owner?.bookedMinutes).toBe(60);
      expect(owner?.utilization).toBeCloseTo(60 / 480, 10);
      expect(member?.bookedMinutes).toBe(60);
      expect(member?.utilization).toBeCloseTo(60 / 480, 10);
    });
  });

  describe('today', () => {
    it("returns today's appointments sorted by start as a plain range query", async () => {
      const schedule = todayScheduleSchema.parse(
        (await ownerAgent.get('/api/reports/today').expect(200)).body,
      );
      expect(schedule.date).toBe(todayStr);
      expect(schedule.items).toHaveLength(3);
      const starts = schedule.items.map((item) => item.start);
      expect(starts).toEqual([dayAt(0, 9), dayAt(0, 10), dayAt(0, 11)]);
      expect(starts).toEqual([...starts].sort());
    });
  });

  describe('tenancy + RBAC', () => {
    it('another organization sees none of our data in any report', async () => {
      const volume = dailyVolumeSchema.parse(
        (await strangerAgent.get('/api/reports/daily-volume?days=30').expect(200)).body,
      );
      expect(volume.points.every((point) => point.count === 0)).toBe(true);

      const breakdown = statusBreakdownSchema.parse(
        (await strangerAgent.get('/api/reports/status-breakdown?days=30').expect(200)).body,
      );
      expect(breakdown.total).toBe(0);
      expect(breakdown.cancellationRate).toBe(0);
      expect(breakdown.noShowRate).toBe(0);

      const utilization = providerUtilizationReportSchema.parse(
        (await strangerAgent.get('/api/reports/provider-utilization?days=30').expect(200)).body,
      );
      expect(utilization.providers).toHaveLength(0);

      const schedule = todayScheduleSchema.parse(
        (await strangerAgent.get('/api/reports/today').expect(200)).body,
      );
      expect(schedule.items).toHaveLength(0);
    });

    it('a member may read reports (MEMBER+)', async () => {
      await memberAgent.get('/api/reports/daily-volume?days=30').expect(200);
      await memberAgent.get('/api/reports/status-breakdown?days=30').expect(200);
      await memberAgent.get('/api/reports/provider-utilization?days=30').expect(200);
      await memberAgent.get('/api/reports/today').expect(200);
    });

    it('rejects an unauthenticated read with 401', async () => {
      await request(app.getHttpServer()).get('/api/reports/daily-volume').expect(401);
    });
  });

  describe('malformed window', () => {
    it('rejects out-of-range and non-integer days with 400 field errors', async () => {
      for (const path of ['daily-volume', 'status-breakdown', 'provider-utilization']) {
        for (const days of ['0', '91', 'abc', '1.5']) {
          const res = await ownerAgent.get(`/api/reports/${path}?days=${days}`).expect(400);
          const parsed = errorResponseSchema.parse(res.body);
          expect(parsed.statusCode).toBe(400);
          expect(parsed.errors.length).toBeGreaterThan(0);
        }
      }
    });

    it('accepts the boundary windows days=1 and days=90', async () => {
      await ownerAgent.get('/api/reports/daily-volume?days=1').expect(200);
      await ownerAgent.get('/api/reports/daily-volume?days=90').expect(200);
    });
  });

  // Runs last: it mutates today's data. Proves the cache populates, serves
  // stale until a write bumps the generation, then recomputes (ADR-0011).
  describe('cache invalidation', () => {
    it('populates on first read, serves stale, then recomputes after a write bumps the generation', async () => {
      const redis = app.get<Redis>(REDIS_CLIENT);
      const connection = app.get<Connection>(getConnectionToken());
      const genKey = `reports:gen:${ownerOrgId}`;

      const baseline = dailyVolumeSchema.parse(
        (await ownerAgent.get('/api/reports/daily-volume?days=30').expect(200)).body,
      );
      const gen0 = Number((await redis.get(genKey)) ?? '0');
      const entryKey0 = `reports:${ownerOrgId}:${gen0}:daily-volume:30`;
      const cachedRaw = await redis.get(entryKey0);
      expect(cachedRaw).not.toBeNull();
      expect(JSON.parse(cachedRaw ?? '{}')).toEqual(baseline);
      const todayCount0 = countOn(baseline, todayStr);

      // A direct datastore write does not bump the generation: the next read
      // is a cache hit and stays stale — proving the cache actually serves.
      const start = new Date(dayAt(0, 15));
      await connection.db?.collection('appointment').insertOne({
        organizationId: ownerOrgId,
        patientId,
        memberId: ownerMemberId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        durationMinutes: 30,
        status: 'SCHEDULED',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const stale = dailyVolumeSchema.parse(
        (await ownerAgent.get('/api/reports/daily-volume?days=30').expect(200)).body,
      );
      expect(countOn(stale, todayStr)).toBe(todayCount0);

      // An HTTP booking bumps the generation: the next read recomputes under a
      // new key and now includes both the direct write and the booking.
      await book({ patientId, memberId: ownerMemberId, start: dayAt(0, 16), durationMinutes: 30 });
      const gen1 = Number((await redis.get(genKey)) ?? '0');
      expect(gen1).toBe(gen0 + 1);
      const fresh = dailyVolumeSchema.parse(
        (await ownerAgent.get('/api/reports/daily-volume?days=30').expect(200)).body,
      );
      expect(countOn(fresh, todayStr)).toBe(todayCount0 + 2);
      expect(await redis.get(`reports:${ownerOrgId}:${gen1}:daily-volume:30`)).not.toBeNull();
    });
  });
});
