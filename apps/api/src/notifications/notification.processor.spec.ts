import type { Job, Queue } from 'bullmq';
import { NotificationProcessor } from './notification.processor.js';
import type { NotificationRepository } from './notification.repository.js';
import type { NotificationDoc } from './notification.schema.js';
import type { PatientRepository } from '../patients/patient.repository.js';
import type { PatientDoc } from '../patients/patient.schema.js';
import type { NotificationChannel, NotificationMessage } from './notification-channel.js';
import {
  APPOINTMENT_CREATED_JOB,
  APPOINTMENT_REMINDER_JOB,
  PATIENT_CREATED_JOB,
  appointmentCreatedJobId,
  appointmentReminderJobId,
  patientCreatedJobId,
  type AppointmentCreatedJob,
  type AppointmentReminderJob,
  type NotificationJob,
  type PatientCreatedJob,
} from './notifications.tokens.js';

function receiptDoc(): NotificationDoc {
  return { _id: 'n1' } as unknown as NotificationDoc;
}

function patientDoc(overrides: Partial<Record<string, unknown>> = {}): PatientDoc {
  return {
    _id: 'p1',
    organizationId: 'org-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    contactEmail: 'ada@example.test',
    ...overrides,
  } as unknown as PatientDoc;
}

interface Calls {
  claims: Array<{ type: string; refId: string }>;
  lookups: string[];
  sent: Array<{ id: string; recipient: string; providerMessageId: string }>;
  skipped: Array<{ id: string }>;
  failed: Array<{ id: string; recipient: string }>;
}

function emptyCalls(): Calls {
  return { claims: [], lookups: [], sent: [], skipped: [], failed: [] };
}

function fakeNotificationRepo(
  calls: Calls,
  claimResult: NotificationDoc | null,
): NotificationRepository {
  return {
    claim: async (_context: unknown, type: string, refId: string) => {
      calls.claims.push({ type, refId });
      return claimResult;
    },
    markSent: async (
      _context: unknown,
      id: string,
      recipient: string,
      providerMessageId: string,
    ) => {
      calls.sent.push({ id, recipient, providerMessageId });
    },
    markSkipped: async (_context: unknown, id: string) => {
      calls.skipped.push({ id });
    },
    markFailed: async (_context: unknown, id: string, recipient: string) => {
      calls.failed.push({ id, recipient });
    },
  } as unknown as NotificationRepository;
}

function fakePatientRepo(calls: Calls, patient: PatientDoc | null): PatientRepository {
  return {
    findOne: async (_context: unknown, filter: { _id: string }) => {
      calls.lookups.push(filter._id);
      return patient;
    },
  } as unknown as PatientRepository;
}

function fakeChannel(
  sent: NotificationMessage[],
  result: { providerMessageId: string } | Error,
): NotificationChannel {
  return {
    send: async (message: NotificationMessage) => {
      sent.push(message);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

function fakeQueue(): Queue<NotificationJob> {
  return { name: 'notifications' } as unknown as Queue<NotificationJob>;
}

function patientJob(): Job<NotificationJob> {
  const data: PatientCreatedJob = {
    organizationId: 'org-1',
    patientId: 'p1',
    patientName: 'Ada Lovelace',
  };
  return {
    id: patientCreatedJobId('p1'),
    name: PATIENT_CREATED_JOB,
    data,
  } as unknown as Job<NotificationJob>;
}

function appointmentCreatedJob(): Job<NotificationJob> {
  const data: AppointmentCreatedJob = {
    organizationId: 'org-1',
    appointmentId: 'a1',
    patientId: 'p1',
    start: '2026-12-20T10:00:00.000Z',
  };
  return {
    id: appointmentCreatedJobId('a1'),
    name: APPOINTMENT_CREATED_JOB,
    data,
  } as unknown as Job<NotificationJob>;
}

function reminderJob(): Job<NotificationJob> {
  const data: AppointmentReminderJob = {
    organizationId: 'org-1',
    appointmentId: 'a1',
    patientId: 'p1',
    start: '2026-12-20T10:00:00.000Z',
  };
  return {
    id: appointmentReminderJobId('a1'),
    name: APPOINTMENT_REMINDER_JOB,
    data,
  } as unknown as Job<NotificationJob>;
}

describe('NotificationProcessor', () => {
  it('resolves the recipient at consume time and records SENT with the provider id', async () => {
    const calls = emptyCalls();
    const sent: NotificationMessage[] = [];
    const processor = new NotificationProcessor(
      fakeQueue(),
      fakeNotificationRepo(calls, receiptDoc()),
      // The payload carries no email; the recipient comes from the Patient doc.
      fakePatientRepo(calls, patientDoc({ contactEmail: 'resolved@example.test' })),
      fakeChannel(sent, { providerMessageId: 'msg-1' }),
    );

    const outcome = await processor.process(patientJob());

    expect(outcome).toEqual({
      status: 'SENT',
      recipient: 'resolved@example.test',
      providerMessageId: 'msg-1',
    });
    expect(calls.claims).toEqual([{ type: 'patient.created', refId: 'p1' }]);
    expect(calls.lookups).toEqual(['p1']);
    expect(calls.sent).toEqual([
      { id: 'n1', recipient: 'resolved@example.test', providerMessageId: 'msg-1' },
    ]);
    expect(sent[0]?.to).toBe('resolved@example.test');
  });

  it('books an appointment.created receipt keyed by appointmentId with a confirmation message', async () => {
    const calls = emptyCalls();
    const sent: NotificationMessage[] = [];
    const processor = new NotificationProcessor(
      fakeQueue(),
      fakeNotificationRepo(calls, receiptDoc()),
      fakePatientRepo(calls, patientDoc()),
      fakeChannel(sent, { providerMessageId: 'msg-2' }),
    );

    const outcome = await processor.process(appointmentCreatedJob());

    expect(outcome.status).toBe('SENT');
    expect(calls.claims).toEqual([{ type: 'appointment.created', refId: 'a1' }]);
    expect(sent[0]?.subject).toBe('Appointment confirmation');
    expect(sent[0]?.text).toContain('Ada Lovelace');
  });

  it('delivers an appointment.reminder keyed by appointmentId with a reminder message', async () => {
    const calls = emptyCalls();
    const sent: NotificationMessage[] = [];
    const processor = new NotificationProcessor(
      fakeQueue(),
      fakeNotificationRepo(calls, receiptDoc()),
      fakePatientRepo(calls, patientDoc()),
      fakeChannel(sent, { providerMessageId: 'msg-3' }),
    );

    const outcome = await processor.process(reminderJob());

    expect(outcome.status).toBe('SENT');
    expect(calls.claims).toEqual([{ type: 'appointment.reminder', refId: 'a1' }]);
    expect(sent[0]?.subject).toBe('Appointment reminder');
  });

  it('records FAILED (no throw) when the transport rejects', async () => {
    const calls = emptyCalls();
    const sent: NotificationMessage[] = [];
    const processor = new NotificationProcessor(
      fakeQueue(),
      fakeNotificationRepo(calls, receiptDoc()),
      fakePatientRepo(calls, patientDoc()),
      fakeChannel(sent, new Error('SMTP unavailable')),
    );

    const outcome = await processor.process(patientJob());

    expect(outcome).toEqual({ status: 'FAILED', recipient: 'ada@example.test' });
    expect(calls.failed).toEqual([{ id: 'n1', recipient: 'ada@example.test' }]);
    expect(calls.sent).toHaveLength(0);
  });

  it('records SKIPPED and never sends when the Patient has no Contact Email', async () => {
    const calls = emptyCalls();
    const sent: NotificationMessage[] = [];
    const processor = new NotificationProcessor(
      fakeQueue(),
      fakeNotificationRepo(calls, receiptDoc()),
      fakePatientRepo(calls, patientDoc({ contactEmail: undefined })),
      fakeChannel(sent, { providerMessageId: 'msg-1' }),
    );

    const outcome = await processor.process(patientJob());

    expect(outcome).toEqual({ status: 'SKIPPED' });
    expect(calls.skipped).toEqual([{ id: 'n1' }]);
    expect(sent).toHaveLength(0);
  });

  it('records SKIPPED when the Patient no longer exists', async () => {
    const calls = emptyCalls();
    const sent: NotificationMessage[] = [];
    const processor = new NotificationProcessor(
      fakeQueue(),
      fakeNotificationRepo(calls, receiptDoc()),
      fakePatientRepo(calls, null),
      fakeChannel(sent, { providerMessageId: 'msg-1' }),
    );

    const outcome = await processor.process(patientJob());

    expect(outcome).toEqual({ status: 'SKIPPED' });
    expect(calls.skipped).toEqual([{ id: 'n1' }]);
    expect(sent).toHaveLength(0);
  });

  it('is DEDUPED when the storage claim already holds a receipt — no lookup, no send', async () => {
    const calls = emptyCalls();
    const sent: NotificationMessage[] = [];
    const processor = new NotificationProcessor(
      fakeQueue(),
      fakeNotificationRepo(calls, null),
      fakePatientRepo(calls, patientDoc()),
      fakeChannel(sent, { providerMessageId: 'msg-1' }),
    );

    const outcome = await processor.process(patientJob());

    expect(outcome).toEqual({ status: 'DEDUPED' });
    expect(calls.claims).toHaveLength(1);
    expect(calls.lookups).toHaveLength(0);
    expect(calls.sent).toHaveLength(0);
    expect(calls.skipped).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('rejects an unknown job name', async () => {
    const calls = emptyCalls();
    const processor = new NotificationProcessor(
      fakeQueue(),
      fakeNotificationRepo(calls, receiptDoc()),
      fakePatientRepo(calls, patientDoc()),
      fakeChannel([], { providerMessageId: 'msg-1' }),
    );
    const job = {
      id: 'x',
      name: 'mystery.event',
      data: { organizationId: 'org-1' },
    } as unknown as Job<NotificationJob>;

    await expect(processor.process(job)).rejects.toThrow('Unknown notification job');
  });

  it('shuts down cleanly when no worker was started', async () => {
    const processor = new NotificationProcessor(
      fakeQueue(),
      fakeNotificationRepo(emptyCalls(), receiptDoc()),
      fakePatientRepo(emptyCalls(), patientDoc()),
      fakeChannel([], { providerMessageId: 'msg-1' }),
    );
    await expect(processor.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
