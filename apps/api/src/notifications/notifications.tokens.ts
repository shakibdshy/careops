export const NOTIFICATIONS_QUEUE = Symbol('NOTIFICATIONS_QUEUE');

export interface PatientCreatedJob {
  organizationId: string;
  patientId: string;
  patientName: string;
}

/** Job name registered in BullMQ; the job id doubles as the idempotency key. */
export const PATIENT_CREATED_JOB = 'patient.created';

/**
 * Idempotency key: BullMQ dedups on the job id while the job exists (waiting
 * or in flight), so crash-redeliveries and double-enqueues collapse into one
 * job. removeOnComplete prunes finished ids — delivery handlers that gain
 * real side effects (week 2) must pair this key with storage-side dedup.
 * (Hyphen, not colon: BullMQ forbids ':' in job ids.)
 */
export function patientCreatedJobId(patientId: string): string {
  return `${PATIENT_CREATED_JOB}-${patientId}`;
}
