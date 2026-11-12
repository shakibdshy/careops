import { z } from 'zod';
import { appointmentSchema, appointmentStatusSchema } from './appointments.js';

/**
 * Reporting window (W2-T7). Reports bucket UTC days over a trailing window;
 * `days` defaults to 30 (the spec's trailing-30-day trend) and is bounded so a
 * malformed value is a 400 at the boundary, never an unbounded scan.
 */
export const reportWindowQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});
export type ReportWindowQuery = z.infer<typeof reportWindowQuerySchema>;

/** One UTC day's appointment count in the volume trend (zero-filled by the API). */
export const dailyVolumePointSchema = z.object({
  /** UTC calendar day, YYYY-MM-DD. */
  date: z.string(),
  count: z.number().int(),
});
export type DailyVolumePoint = z.infer<typeof dailyVolumePointSchema>;

export const dailyVolumeSchema = z.object({
  days: z.number().int(),
  points: z.array(dailyVolumePointSchema),
});
export type DailyVolume = z.infer<typeof dailyVolumeSchema>;

/** Per-status counts (all seven states, zero-filled) plus the operational rates. */
export const statusCountSchema = z.object({
  status: appointmentStatusSchema,
  count: z.number().int(),
});
export type StatusCount = z.infer<typeof statusCountSchema>;

export const statusBreakdownSchema = z.object({
  days: z.number().int(),
  total: z.number().int(),
  counts: z.array(statusCountSchema),
  /** CANCELLED ÷ total, 0..1 (0 when there are no appointments). */
  cancellationRate: z.number(),
  /** NO_SHOW ÷ total, 0..1 (0 when there are no appointments). */
  noShowRate: z.number(),
});
export type StatusBreakdown = z.infer<typeof statusBreakdownSchema>;

/**
 * Per-Provider utilization (glossary: Provider = the Member assigned). Booked
 * minutes against a documented daily capacity over the window; the Provider
 * name is resolved by the API's $lookup, not guessed client-side.
 */
export const providerUtilizationSchema = z.object({
  memberId: z.string(),
  providerName: z.string(),
  bookedMinutes: z.number().int(),
  appointmentCount: z.number().int(),
  /** bookedMinutes ÷ (capacityMinutesPerDay × days), 0..1+. */
  utilization: z.number(),
});
export type ProviderUtilization = z.infer<typeof providerUtilizationSchema>;

export const providerUtilizationReportSchema = z.object({
  days: z.number().int(),
  /** The documented 8h/day capacity constant, in minutes. */
  capacityMinutesPerDay: z.number().int(),
  providers: z.array(providerUtilizationSchema),
});
export type ProviderUtilizationReport = z.infer<typeof providerUtilizationReportSchema>;

/** Today's schedule: a plain indexed range query, not an aggregation. */
export const todayScheduleSchema = z.object({
  /** UTC calendar day, YYYY-MM-DD. */
  date: z.string(),
  items: z.array(appointmentSchema),
});
export type TodaySchedule = z.infer<typeof todayScheduleSchema>;
