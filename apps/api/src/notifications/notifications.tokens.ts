export const NOTIFICATIONS_QUEUE = Symbol('NOTIFICATIONS_QUEUE');

export interface PatientCreatedJob {
  organizationId: string;
  patientId: string;
  patientName: string;
}

/** Job name registered in BullMQ; the idempotency key is the job id. */
export const PATIENT_CREATED_JOB = 'patient.created';

/**
 * Deduplication: the job id is `patient.created:<patientId>`, so BullMQ drops
 * duplicates — redeliveries after a crash never double-send.
 */
export function patientCreatedJobId(patientId: string): string {
  return `${PATIENT_CREATED_JOB}-${patientId}`;
}
