import { z } from 'zod';
import { cursorPage } from './cursor.js';

/**
 * The Appointment lifecycle (glossary: scheduled → confirmed → checked in →
 * in progress → completed, or cancelled / no-show). The transition map that
 * governs which moves are legal lives in the API service; the contract only
 * names the states.
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
