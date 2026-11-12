import {
  appointmentStatusSchema,
  appointmentsListQuerySchema,
  createAppointmentSchema,
} from '@careops/shared';

const validBooking = {
  patientId: 'a'.repeat(24),
  memberId: 'member-1',
  start: '2026-12-01T10:00:00.000Z',
  durationMinutes: 30,
};

describe('createAppointmentSchema (booking validation)', () => {
  it('accepts a valid booking without notes', () => {
    expect(createAppointmentSchema.safeParse(validBooking).success).toBe(true);
  });

  it('accepts the boundary durations 15 and 480 minutes', () => {
    for (const durationMinutes of [15, 480]) {
      expect(createAppointmentSchema.safeParse({ ...validBooking, durationMinutes }).success).toBe(
        true,
      );
    }
  });

  it('rejects durations outside 15–480 or non-integer', () => {
    for (const durationMinutes of [14, 481, 30.5]) {
      expect(createAppointmentSchema.safeParse({ ...validBooking, durationMinutes }).success).toBe(
        false,
      );
    }
  });

  it('requires a 24-char hex Patient id', () => {
    for (const patientId of ['nothex', 'z'.repeat(24), 'a'.repeat(23)]) {
      expect(createAppointmentSchema.safeParse({ ...validBooking, patientId }).success).toBe(false);
    }
  });

  it('requires a non-empty Provider member id of at most 128 chars', () => {
    expect(createAppointmentSchema.safeParse({ ...validBooking, memberId: '' }).success).toBe(
      false,
    );
    expect(
      createAppointmentSchema.safeParse({ ...validBooking, memberId: 'm'.repeat(129) }).success,
    ).toBe(false);
    expect(
      createAppointmentSchema.safeParse({ ...validBooking, memberId: 'm'.repeat(128) }).success,
    ).toBe(true);
  });

  it('accepts ISO datetimes with Z or a numeric offset, rejects the rest', () => {
    expect(
      createAppointmentSchema.safeParse({ ...validBooking, start: '2026-12-01T12:00:00.000+02:00' })
        .success,
    ).toBe(true);
    for (const start of ['not-a-datetime', '2026-12-01', '2026-12-01T10:00:00']) {
      expect(createAppointmentSchema.safeParse({ ...validBooking, start }).success).toBe(false);
    }
  });

  it('caps notes at 2000 characters', () => {
    expect(
      createAppointmentSchema.safeParse({ ...validBooking, notes: 'n'.repeat(2000) }).success,
    ).toBe(true);
    expect(
      createAppointmentSchema.safeParse({ ...validBooking, notes: 'n'.repeat(2001) }).success,
    ).toBe(false);
  });
});

describe('appointmentsListQuerySchema (filter validation)', () => {
  it('defaults the page size to 20 and coerces string limits', () => {
    expect(appointmentsListQuerySchema.parse({}).limit).toBe(20);
    expect(appointmentsListQuerySchema.parse({ limit: '5' }).limit).toBe(5);
  });

  it('rejects limits outside 1–100', () => {
    for (const limit of [0, 101, 'abc']) {
      expect(appointmentsListQuerySchema.safeParse({ limit }).success).toBe(false);
    }
  });

  it('accepts only the seven lifecycle statuses', () => {
    expect(appointmentStatusSchema.options).toEqual([
      'SCHEDULED',
      'CONFIRMED',
      'CHECKED_IN',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    ]);
    expect(appointmentsListQuerySchema.safeParse({ status: 'RESCHEDULED' }).success).toBe(false);
  });

  it('requires a 24-char hex cursor', () => {
    expect(appointmentsListQuerySchema.safeParse({ cursor: 'f'.repeat(24) }).success).toBe(true);
    expect(appointmentsListQuerySchema.safeParse({ cursor: 'zzz' }).success).toBe(false);
  });

  it('rejects from after to, naming the from field', () => {
    const result = appointmentsListQuerySchema.safeParse({
      from: '2026-12-01T11:00:00.000Z',
      to: '2026-12-01T09:00:00.000Z',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['from']);
    }
  });

  it('accepts equal bounds and one-sided windows', () => {
    const same = '2026-12-01T10:00:00.000Z';
    expect(appointmentsListQuerySchema.safeParse({ from: same, to: same }).success).toBe(true);
    expect(appointmentsListQuerySchema.safeParse({ from: same }).success).toBe(true);
    expect(appointmentsListQuerySchema.safeParse({ to: same }).success).toBe(true);
  });

  it('rejects malformed window datetimes', () => {
    expect(appointmentsListQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
    expect(appointmentsListQuerySchema.safeParse({ to: '2026-12-01' }).success).toBe(false);
  });
});
