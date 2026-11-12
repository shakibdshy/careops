import type { AppointmentStatus } from '@careops/shared';

/**
 * The clinic lifecycle (W2-T3). Terminal statuses have no outgoing edges;
 * NO_SHOW is staff-marked, never inferred. Reschedule is legal only while the
 * visit is still upcoming (SCHEDULED or CONFIRMED).
 */
export const ALLOWED_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  SCHEDULED: ['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export const RESCHEDULABLE_STATUSES: readonly AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED'];

export function isAllowedTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
