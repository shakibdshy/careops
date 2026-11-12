import { appointmentStatusSchema } from '@careops/shared';
import type { OrgRequestContext } from '../data/org-scoped.repository.js';
import type { AppointmentDoc } from '../appointments/appointment.schema.js';
import type { ReportsCache } from './reports.cache.js';
import type {
  ProviderUtilizationRow,
  ReportsRepository,
  StatusCountRow,
} from './reports.repository.js';
import {
  CAPACITY_MINUTES_PER_DAY,
  REPORT_CACHE_TTL_SECONDS,
  ReportsService,
  formatUtcDay,
  rate,
  utilization,
  utcDayWindow,
  zeroFilledCounts,
  zeroFilledVolume,
} from './reports.service.js';

const context: OrgRequestContext = { organizationId: 'org-1' };

function appointmentDoc(overrides: Partial<Record<string, unknown>> = {}): AppointmentDoc {
  return {
    _id: 'a1',
    organizationId: 'org-1',
    patientId: 'p1',
    memberId: 'member-1',
    start: new Date('2026-11-12T09:00:00.000Z'),
    end: new Date('2026-11-12T09:30:00.000Z'),
    durationMinutes: 30,
    status: 'SCHEDULED',
    notes: undefined,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as unknown as AppointmentDoc;
}

type RepoOverrides = Partial<{
  dailyVolume: (ctx: OrgRequestContext, start: Date, end: Date) => Promise<Map<string, number>>;
  statusBreakdown: (ctx: OrgRequestContext, start: Date, end: Date) => Promise<StatusCountRow[]>;
  providerUtilization: (
    ctx: OrgRequestContext,
    start: Date,
    end: Date,
  ) => Promise<ProviderUtilizationRow[]>;
  today: (ctx: OrgRequestContext, start: Date, end: Date) => Promise<AppointmentDoc[]>;
}>;

function fakeRepo(overrides: RepoOverrides = {}): ReportsRepository {
  const base = {
    dailyVolume: async () => new Map<string, number>(),
    statusBreakdown: async (): Promise<StatusCountRow[]> => [],
    providerUtilization: async (): Promise<ProviderUtilizationRow[]> => [],
    today: async (): Promise<AppointmentDoc[]> => [],
  };
  return { ...base, ...overrides } as unknown as ReportsRepository;
}

interface WrapCall {
  organizationId: string;
  report: string;
  days: number;
  ttl: number;
}

/** Runs the compute inline (like a perpetual miss) and records the wrap arguments. */
function fakeCache(): { cache: ReportsCache; calls: WrapCall[] } {
  const calls: WrapCall[] = [];
  const cache = {
    wrap: async <T>(
      organizationId: string,
      report: string,
      days: number,
      ttl: number,
      compute: () => Promise<T>,
    ): Promise<T> => {
      calls.push({ organizationId, report, days, ttl });
      return compute();
    },
    bumpGeneration: async () => undefined,
  } as unknown as ReportsCache;
  return { cache, calls };
}

describe('report math helpers', () => {
  it('documents an 8h/day capacity and a TTL backstop', () => {
    expect(CAPACITY_MINUTES_PER_DAY).toBe(480);
    expect(REPORT_CACHE_TTL_SECONDS).toBeGreaterThan(0);
  });

  it('formats a UTC calendar day', () => {
    expect(formatUtcDay(new Date('2026-11-12T23:59:59.000Z'))).toBe('2026-11-12');
    expect(formatUtcDay(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01');
  });

  it('builds a half-open trailing window ending today (days=1)', () => {
    const { start, end } = utcDayWindow(1, new Date('2026-11-12T15:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-13T00:00:00.000Z');
  });

  it('spans exactly `days` calendar days including today (days=30)', () => {
    const now = new Date('2026-11-12T15:00:00.000Z');
    const { start, end } = utcDayWindow(30, now);
    expect(start.toISOString()).toBe('2026-10-14T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect((end.getTime() - start.getTime()) / 86_400_000).toBe(30);
  });

  it('crosses a year boundary correctly', () => {
    const { start } = utcDayWindow(30, new Date('2026-01-01T08:00:00.000Z'));
    expect(start.toISOString()).toBe('2025-12-03T00:00:00.000Z');
  });

  it('computes utilization against the documented daily capacity, allowing overbooking', () => {
    expect(utilization(480)).toBe(1);
    expect(utilization(240)).toBe(0.5);
    expect(utilization(960)).toBe(2);
    expect(utilization(480 * 30)).toBe(30);
    expect(utilization(0)).toBe(0);
  });

  it('computes a rate, and 0 for an empty total', () => {
    expect(rate(1, 4)).toBe(0.25);
    expect(rate(0, 5)).toBe(0);
    expect(rate(0, 0)).toBe(0);
    expect(rate(3, 0)).toBe(0);
  });

  it('zero-fills the volume trend, one point per day', () => {
    const start = new Date('2026-11-10T00:00:00.000Z');
    const counts = new Map<string, number>([['2026-11-11', 5]]);
    expect(zeroFilledVolume(counts, start, 3)).toEqual([
      { date: '2026-11-10', count: 0 },
      { date: '2026-11-11', count: 5 },
      { date: '2026-11-12', count: 0 },
    ]);
  });

  it('zero-fills an empty volume window', () => {
    const points = zeroFilledVolume(new Map(), new Date('2026-11-10T00:00:00.000Z'), 2);
    expect(points).toEqual([
      { date: '2026-11-10', count: 0 },
      { date: '2026-11-11', count: 0 },
    ]);
  });

  it('zero-fills all seven statuses in contract order', () => {
    const counts = zeroFilledCounts([]);
    expect(counts.map((entry) => entry.status)).toEqual([...appointmentStatusSchema.options]);
    expect(counts.every((entry) => entry.count === 0)).toBe(true);
  });

  it('merges present status counts and zero-fills the rest', () => {
    const counts = zeroFilledCounts([
      { status: 'COMPLETED', count: 2 },
      { status: 'CANCELLED', count: 1 },
    ]);
    const byStatus = new Map(counts.map((entry) => [entry.status, entry.count]));
    expect(byStatus.get('COMPLETED')).toBe(2);
    expect(byStatus.get('CANCELLED')).toBe(1);
    expect(byStatus.get('SCHEDULED')).toBe(0);
    expect(counts).toHaveLength(appointmentStatusSchema.options.length);
  });
});

describe('ReportsService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-12T15:00:00.000Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('daily-volume caches under the org generation and zero-fills the trend', async () => {
    const { cache, calls } = fakeCache();
    const repository = fakeRepo({
      dailyVolume: async () => new Map<string, number>([['2026-11-11', 5]]),
    });
    const service = new ReportsService(repository, cache);

    const report = await service.dailyVolume(context, { days: 3 });

    expect(calls).toEqual([
      { organizationId: 'org-1', report: 'daily-volume', days: 3, ttl: REPORT_CACHE_TTL_SECONDS },
    ]);
    expect(report).toEqual({
      days: 3,
      points: [
        { date: '2026-11-10', count: 0 },
        { date: '2026-11-11', count: 5 },
        { date: '2026-11-12', count: 0 },
      ],
    });
  });

  it('daily-volume defaults to a 30-day zero-filled trend for an empty org', async () => {
    const { cache } = fakeCache();
    const service = new ReportsService(fakeRepo(), cache);
    const report = await service.dailyVolume(context, { days: 30 });
    expect(report.days).toBe(30);
    expect(report.points).toHaveLength(30);
    expect(report.points.every((point) => point.count === 0)).toBe(true);
    expect(report.points.at(-1)?.date).toBe('2026-11-12');
  });

  it('status-breakdown totals counts and derives cancellation/No-Show rates', async () => {
    const { cache } = fakeCache();
    const repository = fakeRepo({
      statusBreakdown: async () => [
        { status: 'COMPLETED', count: 2 },
        { status: 'CANCELLED', count: 1 },
        { status: 'NO_SHOW', count: 1 },
      ],
    });
    const service = new ReportsService(repository, cache);

    const report = await service.statusBreakdown(context, { days: 30 });

    expect(report.total).toBe(4);
    expect(report.cancellationRate).toBe(0.25);
    expect(report.noShowRate).toBe(0.25);
    expect(report.counts).toHaveLength(7);
    expect(report.counts.find((entry) => entry.status === 'SCHEDULED')?.count).toBe(0);
  });

  it('status-breakdown is all-zero with 0 rates for an empty window', async () => {
    const { cache } = fakeCache();
    const service = new ReportsService(fakeRepo(), cache);
    const report = await service.statusBreakdown(context, { days: 30 });
    expect(report.total).toBe(0);
    expect(report.cancellationRate).toBe(0);
    expect(report.noShowRate).toBe(0);
    expect(report.counts.every((entry) => entry.count === 0)).toBe(true);
  });

  it('provider-utilization caches and computes utilization against the capacity constant', async () => {
    const { cache, calls } = fakeCache();
    const repository = fakeRepo({
      providerUtilization: async () => [
        { memberId: 'member-1', providerName: 'Owner', bookedMinutes: 480, appointmentCount: 16 },
        { memberId: 'member-2', providerName: 'Admin', bookedMinutes: 240, appointmentCount: 8 },
      ],
    });
    const service = new ReportsService(repository, cache);

    const report = await service.providerUtilization(context, { days: 1 });

    expect(calls).toEqual([
      {
        organizationId: 'org-1',
        report: 'provider-utilization',
        days: 1,
        ttl: REPORT_CACHE_TTL_SECONDS,
      },
    ]);
    expect(report.capacityMinutesPerDay).toBe(480);
    expect(report.providers).toEqual([
      {
        memberId: 'member-1',
        providerName: 'Owner',
        bookedMinutes: 480,
        appointmentCount: 16,
        utilization: 1,
      },
      {
        memberId: 'member-2',
        providerName: 'Admin',
        bookedMinutes: 240,
        appointmentCount: 8,
        utilization: 0.5,
      },
    ]);
  });

  it('provider-utilization is empty for an org with no booked providers', async () => {
    const { cache } = fakeCache();
    const service = new ReportsService(fakeRepo(), cache);
    const report = await service.providerUtilization(context, { days: 30 });
    expect(report.providers).toEqual([]);
    expect(report.capacityMinutesPerDay).toBe(480);
  });

  it("today maps the range query to DTOs under today's UTC date", async () => {
    const { cache } = fakeCache();
    const repository = fakeRepo({ today: async () => [appointmentDoc()] });
    const service = new ReportsService(repository, cache);

    const schedule = await service.today(context);

    expect(schedule.date).toBe('2026-11-12');
    expect(schedule.items).toHaveLength(1);
    expect(schedule.items[0]?.id).toBe('a1');
    expect(schedule.items[0]?.start).toBe('2026-11-12T09:00:00.000Z');
    expect(schedule.items[0]?.status).toBe('SCHEDULED');
  });

  it('today is an empty schedule for an org with no appointments today', async () => {
    const { cache } = fakeCache();
    const service = new ReportsService(fakeRepo(), cache);
    const schedule = await service.today(context);
    expect(schedule.date).toBe('2026-11-12');
    expect(schedule.items).toEqual([]);
  });
});
