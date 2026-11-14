import {
  ALLOWED_TRANSITIONS,
  appointmentStatusSchema,
  FREED_STATUSES,
  isAllowedTransition,
  isTerminal,
  canReschedule,
  SLOT_HOLDING_STATUSES,
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

describe('lifecycle helpers', () => {
  it('isTerminal matches the statuses with no outgoing edges', () => {
    for (const status of ALL_STATUSES) {
      expect(isTerminal(status)).toBe(ALLOWED_TRANSITIONS[status].length === 0);
    }
  });

  it('canReschedule admits exactly the Reschedule-window statuses', () => {
    expect(canReschedule('SCHEDULED')).toBe(true);
    expect(canReschedule('CONFIRMED')).toBe(true);
    for (const status of ALL_STATUSES) {
      expect(canReschedule(status)).toBe(status === 'SCHEDULED' || status === 'CONFIRMED');
    }
  });

  it('SLOT_HOLDING_STATUSES holds every status except CANCELLED and NO_SHOW', () => {
    expect([...SLOT_HOLDING_STATUSES].sort()).toEqual(
      ALL_STATUSES.filter((status) => status !== 'CANCELLED' && status !== 'NO_SHOW').sort(),
    );
    expect([...FREED_STATUSES].sort()).toEqual(['CANCELLED', 'NO_SHOW']);
    expect([...SLOT_HOLDING_STATUSES, ...FREED_STATUSES].sort()).toEqual([...ALL_STATUSES].sort());
  });
});
