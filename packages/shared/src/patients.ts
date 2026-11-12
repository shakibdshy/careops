import { z } from 'zod';
import { cursorPage } from './cursor.js';

/** A Patient record (glossary: org-scoped operational record; never logs in). */
export const patientSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  dateOfBirth: z.string(),
  phone: z.string().optional(),
  contactEmail: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Patient = z.infer<typeof patientSchema>;

export const createPatientSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  // ISO date string (YYYY-MM-DD), must be in the past. Persisted as a Date;
  // the contract speaks strings in both directions.
  dateOfBirth: z.iso
    .date()
    .refine((date) => new Date(`${date}T00:00:00Z`).getTime() <= Date.now(), {
      message: 'must be a date in the past',
    }),
  phone: z.string().min(7).max(20).optional(),
  // Contact Email (glossary): optional notification destination; the Patient
  // never authenticates with it. 254 is the RFC 5321 address limit.
  contactEmail: z.email().max(254).optional(),
  notes: z.string().max(2000).optional(),
});
export type CreatePatientDto = z.infer<typeof createPatientSchema>;

/** Paginated patient list: items are Patients, cursor is the last item's id. */
export const patientsPageSchema = cursorPage(patientSchema);
export type PatientsPage = z.infer<typeof patientsPageSchema>;

export const updatePatientSchema = createPatientSchema
  .partial()
  .refine((dto) => Object.keys(dto).length > 0, 'must change at least one field');
export type UpdatePatientDto = z.infer<typeof updatePatientSchema>;

/** An immutable who/what/when/before→after record of a mutation. */
export const auditEntrySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  actorId: z.string(),
  actorEmail: z.string(),
  action: z.enum(['create', 'update', 'delete']),
  entity: z.string(),
  entityId: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  at: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** Paginated audit list: newest first, cursor is the last entry's id. */
export const auditEntriesPageSchema = cursorPage(auditEntrySchema);
export type AuditEntriesPage = z.infer<typeof auditEntriesPageSchema>;
