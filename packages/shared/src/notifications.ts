import { z } from 'zod';

/**
 * A Notification (glossary) is the durable receipt of one delivery attempt to a
 * Patient's Contact Email. The status records the outcome: PENDING while claimed,
 * SENT on transport success, FAILED on transport error, SKIPPED when the Patient
 * has no Contact Email (never a silent drop).
 */
export const notificationStatusSchema = z.enum(['PENDING', 'SENT', 'FAILED', 'SKIPPED']);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

/**
 * The event that produced the Notification. Doubles as the BullMQ job name and
 * the `type` discriminator in the storage-side dedup key {organizationId, type,
 * refId}: one receipt per event per referenced entity.
 */
export const notificationTypeSchema = z.enum([
  'appointment.created',
  'appointment.reminder',
  'patient.created',
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

/** The stored receipt, contract-shaped (ISO timestamps, string id). */
export const notificationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: notificationTypeSchema,
  refId: z.string(),
  // Resolved at consume time from the Patient; absent on a SKIPPED receipt.
  recipient: z.string().optional(),
  status: notificationStatusSchema,
  providerMessageId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Notification = z.infer<typeof notificationSchema>;
