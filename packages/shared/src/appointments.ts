import { z } from 'zod';
import { cursorPage } from './cursor.js';

/**
 * The Appointment lifecycle (glossary: scheduled → confirmed → checked in →
 * in progress → completed, or cancelled / no-show). The pure transition map
 * that governs which moves are legal lives in ./appointment-status.ts so the
 * API enforces and the web renders the same edges; the contract names the states.
 */
export const appointmentStatusSchema = z.enum([
  'SCHEDULED',
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
]);
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>;

// Patient ids are Mongoose ObjectIds; Provider ids come from BetterAuth's
// adapter-owned member collection (UUIDs by default) and stay opaque.
const objectIdHex = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-char hex id');
const memberIdSchema = z.string().min(1).max(128);

/** A scheduled block of a Provider's time for one Patient (glossary). */
export const appointmentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  patientId: z.string(),
  memberId: z.string(),
  // UTC ISO datetime, Z-normalized in both directions.
  start: z.string(),
  durationMinutes: z.number().int(),
  status: appointmentStatusSchema,
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Appointment = z.infer<typeof appointmentSchema>;

export const createAppointmentSchema = z.object({
  patientId: objectIdHex,
  memberId: memberIdSchema,
  start: z.iso.datetime({ offset: true }),
  durationMinutes: z.number().int().min(15).max(480),
  notes: z.string().max(2000).optional(),
});
export type CreateAppointmentDto = z.infer<typeof createAppointmentSchema>;

/** Single transition endpoint body: the target status of the lifecycle. */
export const appointmentTransitionSchema = z.object({
  status: appointmentStatusSchema,
});
export type AppointmentTransitionDto = z.infer<typeof appointmentTransitionSchema>;

/**
 * Reschedule (glossary): change an upcoming Appointment's start, duration, or
 * Provider. At least one field is required; the API re-runs the Conflict check.
 */
export const rescheduleAppointmentSchema = z
  .object({
    start: z.iso.datetime({ offset: true }).optional(),
    durationMinutes: z.number().int().min(15).max(480).optional(),
    memberId: memberIdSchema.optional(),
  })
  .refine(
    (dto) =>
      dto.start !== undefined || dto.durationMinutes !== undefined || dto.memberId !== undefined,
    { message: 'at least one of start, durationMinutes, or memberId is required' },
  );
export type RescheduleAppointmentDto = z.infer<typeof rescheduleAppointmentSchema>;

/** List filters + ADR-0008 cursor paging; malformed values are 400s, never CastErrors. */
export const appointmentsListQuerySchema = z
  .object({
    status: appointmentStatusSchema.optional(),
    memberId: memberIdSchema.optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z
      .string()
      .regex(/^[0-9a-fA-F]{24}$/, 'must be a valid page cursor')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((query) => !query.from || !query.to || new Date(query.from) <= new Date(query.to), {
    message: 'from must not be after to',
    path: ['from'],
  });
export type AppointmentsListQuery = z.infer<typeof appointmentsListQuerySchema>;

/** Paginated appointment list: newest booking first, cursor is the last item's id. */
export const appointmentsPageSchema = cursorPage(appointmentSchema);
export type AppointmentsPage = z.infer<typeof appointmentsPageSchema>;
