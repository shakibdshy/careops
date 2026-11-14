import { appointmentStatusSchema, type AppointmentStatus } from './appointments.js';

/**
 * The clinic lifecycle (W2-T3). Terminal statuses have no outgoing edges;
 * NO_SHOW is staff-marked, never inferred. Reschedule is legal only while the
 * visit is still upcoming (SCHEDULED or CONFIRMED). Shared so the API enforces
 * and the web renders the same legal moves (ADR-0002).
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

/**
 * Statuses that still hold the Provider's time — the Conflict check (glossary)
 * and the utilization reports share this rule: a freed slot can be rebooked.
 * FREED_STATUSES is the complement, so the repositories can encode the rule as
 * a Mongo `$nin: [...FREED_STATUSES]` filter from this single source.
 */
export const SLOT_HOLDING_STATUSES: readonly AppointmentStatus[] =
  appointmentStatusSchema.options.filter(
    (status) => status !== 'CANCELLED' && status !== 'NO_SHOW',
  );

export const FREED_STATUSES: readonly AppointmentStatus[] = appointmentStatusSchema.options.filter(
  (status) => !SLOT_HOLDING_STATUSES.includes(status),
);

export function isAllowedTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Terminal = no transition leaves this status (COMPLETED, CANCELLED, NO_SHOW). */
export function isTerminal(status: AppointmentStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

/** Reschedule (glossary): only SCHEDULED or CONFIRMED appointments may move. */
export function canReschedule(status: AppointmentStatus): boolean {
  return RESCHEDULABLE_STATUSES.includes(status);
}
