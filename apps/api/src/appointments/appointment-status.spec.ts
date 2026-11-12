import {
  ALLOWED_TRANSITIONS,
  appointmentStatusSchema,
  isAllowedTransition,
  type AppointmentStatus,
} from '@careops/shared';

// The ticket's transition table, transcribed independently of the implementation.
const EXPECTED: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  SCHEDULED: ['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

const ALL_STATUSES = appointmentStatusSchema.options;

describe('appointment lifecycle transition map', () => {
  it('covers exactly the seven contract statuses', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const allowed = EXPECTED[from].includes(to);
      it(`${from} → ${to} is ${allowed ? 'allowed' : 'rejected'}`, () => {
        expect(isAllowedTransition(from, to)).toBe(allowed);
        expect(ALLOWED_TRANSITIONS[from]).toEqual(EXPECTED[from]);
      });
    }
  }

  it('terminal statuses reject every target, including themselves', () => {
    for (const terminal of ['COMPLETED', 'CANCELLED', 'NO_SHOW'] as const) {
      expect(ALLOWED_TRANSITIONS[terminal]).toEqual([]);
      for (const to of ALL_STATUSES) {
        expect(isAllowedTransition(terminal, to)).toBe(false);
      }
    }
  });
});
