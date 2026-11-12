export const NOTIFICATIONS_QUEUE = Symbol('NOTIFICATIONS_QUEUE');

export interface PatientCreatedJob {
  organizationId: string;
  patientId: string;
  patientName: string;
}

/**
 * Appointment events carry ids + the start (ISO), never the recipient: the
 * Contact Email is resolved from the Patient at consume time so the payload
 * stays small and a changed email is honoured (ticket #29).
 */
export interface AppointmentCreatedJob {
  organizationId: string;
  appointmentId: string;
  patientId: string;
  start: string;
}

export interface AppointmentReminderJob {
  organizationId: string;
  appointmentId: string;
  patientId: string;
  start: string;
}

export type NotificationJob = PatientCreatedJob | AppointmentCreatedJob | AppointmentReminderJob;

/** Job names registered in BullMQ; each job id doubles as the idempotency key. */
export const PATIENT_CREATED_JOB = 'patient.created';
export const APPOINTMENT_CREATED_JOB = 'appointment.created';
export const APPOINTMENT_REMINDER_JOB = 'appointment.reminder';

/** A reminder fires this long before the Appointment start (start − 24h). */
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Idempotency keys: BullMQ dedups on the job id while the job exists (waiting
 * or in flight), so crash-redeliveries and double-enqueues collapse into one
 * job. removeOnComplete prunes finished ids — delivery handlers pair this key
 * with storage-side dedup (the notification unique index) for real side effects.
 * (Hyphen, not colon: BullMQ forbids ':' in job ids.)
 */
export function patientCreatedJobId(patientId: string): string {
  return `${PATIENT_CREATED_JOB}-${patientId}`;
}

export function appointmentCreatedJobId(appointmentId: string): string {
  return `${APPOINTMENT_CREATED_JOB}-${appointmentId}`;
}

export function appointmentReminderJobId(appointmentId: string): string {
  return `${APPOINTMENT_REMINDER_JOB}-${appointmentId}`;
}
