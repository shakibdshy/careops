import { Injectable } from '@nestjs/common';
import {
  appointmentStatusSchema,
  type DailyVolume,
  type DailyVolumePoint,
  type ProviderUtilizationReport,
  type ReportWindowQuery,
  type StatusBreakdown,
  type StatusCount,
  type TodaySchedule,
} from '@careops/shared';
import type { OrgRequestContext } from '../data/org-scoped.repository.js';
import { toAppointmentDto } from '../appointments/appointments.service.js';
import { ReportsCache } from './reports.cache.js';
import { ReportsRepository, type StatusCountRow } from './reports.repository.js';

/**
 * Documented Provider capacity: an 8-hour clinic day. Utilization is booked
 * minutes against this constant over the window (W2-T7 spec), so the number is
 * reproducible and the assumption is explicit rather than buried in a query.
 */
export const CAPACITY_MINUTES_PER_DAY = 480;

/** TTL backstop for the cached reports; the generation counter is the real invalidator (ADR-0011). */
export const REPORT_CACHE_TTL_SECONDS = 300;

const MS_PER_DAY = 86_400_000;

/** UTC calendar day, YYYY-MM-DD — the bucket key the aggregation groups by. */
export function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The trailing `days` UTC calendar days ending today: [midnight (days-1) days
 * ago, midnight tomorrow). Half-open so today is fully included and the window
 * is exactly `days` buckets.
 */
export function utcDayWindow(days: number, now: Date): { start: Date; end: Date } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    start: new Date(midnight - (days - 1) * MS_PER_DAY),
    end: new Date(midnight + MS_PER_DAY),
  };
}

/** Booked minutes ÷ (daily capacity × days). May exceed 1 for an overbooked Provider. */
export function utilization(bookedMinutes: number, days: number): number {
  return bookedMinutes / (CAPACITY_MINUTES_PER_DAY * days);
}

/** A share of the total, 0 when there is nothing to divide (empty window). */
export function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

/** One point per UTC day in the window, zero-filled where no appointments fell. */
export function zeroFilledVolume(
  counts: Map<string, number>,
  start: Date,
  days: number,
): DailyVolumePoint[] {
  const points: DailyVolumePoint[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = formatUtcDay(new Date(start.getTime() + i * MS_PER_DAY));
    points.push({ date, count: counts.get(date) ?? 0 });
  }
  return points;
}

/** All seven lifecycle states in contract order, zero-filled where absent. */
export function zeroFilledCounts(rows: StatusCountRow[]): StatusCount[] {
  const byStatus = new Map(rows.map((row) => [row.status, row.count]));
  return appointmentStatusSchema.options.map((status) => ({
    status,
    count: byStatus.get(status) ?? 0,
  }));
}

/**
 * Reporting reads (W2-T7). daily-volume and provider-utilization are cached
 * cache-aside under the org's generation counter; status-breakdown and today
 * are computed live (today is a plain indexed range query, never an
 * aggregation). Every read is org-scoped by the repository (ADR-0006).
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly repository: ReportsRepository,
    private readonly cache: ReportsCache,
  ) {}

  async dailyVolume(context: OrgRequestContext, query: ReportWindowQuery): Promise<DailyVolume> {
    return this.cache.wrap(
      context.organizationId,
      'daily-volume',
      query.days,
      REPORT_CACHE_TTL_SECONDS,
      async () => {
        const { start, end } = utcDayWindow(query.days, new Date());
        const counts = await this.repository.dailyVolume(context, start, end);
        return { days: query.days, points: zeroFilledVolume(counts, start, query.days) };
      },
    );
  }

  async statusBreakdown(
    context: OrgRequestContext,
    query: ReportWindowQuery,
  ): Promise<StatusBreakdown> {
    const { start, end } = utcDayWindow(query.days, new Date());
    const rows = await this.repository.statusBreakdown(context, start, end);
    const counts = zeroFilledCounts(rows);
    const total = counts.reduce((sum, entry) => sum + entry.count, 0);
    const cancelled = rows.find((row) => row.status === 'CANCELLED')?.count ?? 0;
    const noShow = rows.find((row) => row.status === 'NO_SHOW')?.count ?? 0;
    return {
      days: query.days,
      total,
      counts,
      cancellationRate: rate(cancelled, total),
      noShowRate: rate(noShow, total),
    };
  }

  async providerUtilization(
    context: OrgRequestContext,
    query: ReportWindowQuery,
  ): Promise<ProviderUtilizationReport> {
    return this.cache.wrap(
      context.organizationId,
      'provider-utilization',
      query.days,
      REPORT_CACHE_TTL_SECONDS,
      async () => {
        const { start, end } = utcDayWindow(query.days, new Date());
        const rows = await this.repository.providerUtilization(context, start, end);
        return {
          days: query.days,
          capacityMinutesPerDay: CAPACITY_MINUTES_PER_DAY,
          providers: rows.map((row) => ({
            memberId: row.memberId,
            providerName: row.providerName,
            bookedMinutes: row.bookedMinutes,
            appointmentCount: row.appointmentCount,
            utilization: utilization(row.bookedMinutes, query.days),
          })),
        };
      },
    );
  }

  async today(context: OrgRequestContext): Promise<TodaySchedule> {
    const { start, end } = utcDayWindow(1, new Date());
    const docs = await this.repository.today(context, start, end);
    return { date: formatUtcDay(start), items: docs.map(toAppointmentDto) };
  }
}
