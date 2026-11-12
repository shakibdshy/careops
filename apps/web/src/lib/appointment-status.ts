import type { AppointmentStatus } from '@careops/shared';

/**
 * Presentation metadata for each Appointment status. Shared so the booking
 * table and the dashboard render identical labels and light/dark badges.
 */
export const STATUS_META: Record<
  AppointmentStatus,
  { label: string; action: string; badge: string }
> = {
  SCHEDULED: {
    label: 'Scheduled',
    action: 'Schedule',
    badge: 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  },
  CONFIRMED: {
    label: 'Confirmed',
    action: 'Confirm',
    badge: 'border-indigo-500/20 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
  },
  CHECKED_IN: {
    label: 'Checked in',
    action: 'Check in',
    badge: 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  IN_PROGRESS: {
    label: 'In progress',
    action: 'Start',
    badge: 'border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  },
  COMPLETED: {
    label: 'Completed',
    action: 'Complete',
    badge: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  CANCELLED: {
    label: 'Cancelled',
    action: 'Cancel',
    badge: 'border-border bg-muted text-muted-foreground',
  },
  NO_SHOW: {
    label: 'No-show',
    action: 'No-show',
    badge: 'border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300',
  },
};
