import request from 'supertest';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { Collection } from 'mongodb';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import type { Queue } from 'bullmq';
import { appointmentSchema, organizationCurrentSchema, patientSchema } from '@careops/shared';
import { setupE2eApp, type E2eHarness } from './mongo.js';
import type { RecordingNotificationChannel } from './fake-notification-channel.js';
import { NOTIFICATION_CHANNEL } from '../src/notifications/notification-channel.js';
import {
  APPOINTMENT_CREATED_JOB,
  NOTIFICATIONS_QUEUE,
  appointmentCreatedJobId,
  appointmentReminderJobId,
  type NotificationJob,
} from '../src/notifications/notifications.tokens.js';

const OWNER = {
  name: 'Owner N',
  email: 'owner-n@example.test',
  password: 'correct-horse-battery-staple',
};
const CONTACT_EMAIL = 'ada.lovelace@example.test';
const validPatient = { firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1990-12-10' };

async function waitFor<T>(predicate: () => Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result !== undefined) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

describe('Notifications (e2e)', () => {
  let app: INestApplication<App>;
  let harness: E2eHarness;
  let ownerAgent: ReturnType<typeof request.agent>;
  let orgId: string;
  let ownerMemberId: string;
  let patientId: string;
  let noEmailPatientId: string;
  let notifications: Collection;
  let queue: Queue<NotificationJob>;
  let channel: RecordingNotificationChannel;

  // Far-future monotonic slots: every booking is conflict-free and more than
  // 24h out, so each one arms a delayed reminder the cancel test can withdraw.
  let slotCounter = 0;
  const nextSlot = () => {
    const start = new Date(Date.parse('2026-12-20T00:00:00.000Z') + slotCounter * 30 * 60_000);
    slotCounter += 1;
    return start.toISOString();
  };

  const book = async (patient: string) => {
    const res = await ownerAgent
      .post('/api/appointments')
      .send({ patientId: patient, memberId: ownerMemberId, start: nextSlot(), durationMinutes: 30 })
      .expect(201);
    return appointmentSchema.parse(res.body);
  };

  const waitForReceipt = (type: string, refId: string) =>
    waitFor(async () => {
      const doc = await notifications.findOne({ organizationId: orgId, type, refId });
      return doc && doc['status'] !== 'PENDING' ? doc : undefined;
    });

  beforeAll(async () => {
    harness = await setupE2eApp('careops-notifications-test');
    app = harness.app;
    ownerAgent = request.agent(app.getHttpServer());

    await ownerAgent.post('/api/auth/sign-up/email').send(OWNER).expect(200);
    const current = organizationCurrentSchema.parse(
      (await ownerAgent.get('/api/organizations/current').expect(200)).body,
    );
    orgId = current.id;
    const ownerMember = current.members.find((member) => member.role === 'owner');
    if (!ownerMember) {
      throw new Error('expected an owner member in the organization');
    }
    ownerMemberId = ownerMember.id;

    patientId = patientSchema.parse(
      (
        await ownerAgent
          .post('/api/patients')
          .send({ ...validPatient, contactEmail: CONTACT_EMAIL })
          .expect(201)
      ).body,
    ).id;
    noEmailPatientId = patientSchema.parse(
      (await ownerAgent.post('/api/patients').send(validPatient).expect(201)).body,
    ).id;

    const db = app.get<Connection>(getConnectionToken()).db;
    if (!db) {
      throw new Error('expected a live database connection');
    }
    notifications = db.collection('notification');
    queue = app.get<Queue<NotificationJob>>(NOTIFICATIONS_QUEUE);
    channel = app.get<RecordingNotificationChannel>(NOTIFICATION_CHANNEL);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('delivers patient.created for real: SENT with the Contact Email recipient', async () => {
    const receipt = await waitForReceipt('patient.created', patientId);
    expect(receipt['status']).toBe('SENT');
    expect(receipt['recipient']).toBe(CONTACT_EMAIL);
    expect(receipt['providerMessageId']).toBeTruthy();
  });

  it('records a SENT confirmation with recipient + providerMessageId on booking', async () => {
    const appointment = await book(patientId);
    const receipt = await waitForReceipt('appointment.created', appointment.id);
    expect(receipt['status']).toBe('SENT');
    expect(receipt['recipient']).toBe(CONTACT_EMAIL);
    expect(typeof receipt['providerMessageId']).toBe('string');
    expect(
      channel.sent.some(
        (message) => message.to === CONTACT_EMAIL && message.subject === 'Appointment confirmation',
      ),
    ).toBe(true);
  });

  it('a duplicate enqueue is a storage dedup hit — no second receipt', async () => {
    const appointment = await book(patientId);
    await waitForReceipt('appointment.created', appointment.id);

    // Replay the same event under a fresh jobId so BullMQ cannot collapse it:
    // only the durable {org, type, refId} unique index can stop the second send.
    const replayId = `${appointmentCreatedJobId(appointment.id)}-replay`;
    await queue.add(
      APPOINTMENT_CREATED_JOB,
      {
        organizationId: orgId,
        appointmentId: appointment.id,
        patientId,
        start: appointment.start,
      },
      { jobId: replayId },
    );
    await waitFor(async () => {
      const job = await queue.getJob(replayId);
      return job && (await job.getState()) === 'completed' ? true : undefined;
    });

    const records = await notifications
      .find({ organizationId: orgId, type: 'appointment.created', refId: appointment.id })
      .toArray();
    expect(records).toHaveLength(1);
    expect(records[0]?.['status']).toBe('SENT');
  });

  it('records SKIPPED (never a silent drop) when the Patient has no Contact Email', async () => {
    const appointment = await book(noEmailPatientId);
    const receipt = await waitForReceipt('appointment.created', appointment.id);
    expect(receipt['status']).toBe('SKIPPED');
    expect(receipt['recipient']).toBeUndefined();
    expect(receipt['providerMessageId']).toBeUndefined();
  });

  it('cancelling a booked appointment withdraws its pending reminder', async () => {
    const appointment = await book(patientId);
    const reminderId = appointmentReminderJobId(appointment.id);
    const pending = await queue.getJob(reminderId);
    expect(pending).toBeDefined();
    expect(await pending?.getState()).toBe('delayed');

    await ownerAgent
      .post(`/api/appointments/${appointment.id}/status`)
      .send({ status: 'CANCELLED' })
      .expect(200);

    const after = await queue.getJob(reminderId);
    expect(after).toBeUndefined();
  });
});
