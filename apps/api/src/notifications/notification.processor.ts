import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import type { NotificationType } from '@careops/shared';
import { loadConfig } from '../config/env.js';
import { PatientRepository } from '../patients/patient.repository.js';
import type { PatientDoc } from '../patients/patient.schema.js';
import { NotificationRepository } from './notification.repository.js';
import { NOTIFICATION_CHANNEL } from './notification-channel.js';
import type { NotificationChannel, NotificationMessage } from './notification-channel.js';
import {
  APPOINTMENT_CREATED_JOB,
  APPOINTMENT_REMINDER_JOB,
  NOTIFICATIONS_QUEUE,
  PATIENT_CREATED_JOB,
} from './notifications.tokens.js';
import type {
  AppointmentCreatedJob,
  AppointmentReminderJob,
  NotificationJob,
  PatientCreatedJob,
} from './notifications.tokens.js';

/** What one consume attempt did; the receipt is persisted, this is for tests/logs. */
export interface NotificationOutcome {
  status: 'SENT' | 'FAILED' | 'SKIPPED' | 'DEDUPED';
  recipient?: string;
  providerMessageId?: string;
}

interface JobDescriptor {
  type: NotificationType;
  refId: string;
  patientId: string;
}

/**
 * Real delivery (ticket #29). Each job claims a durable PENDING receipt (the
 * unique {org, type, refId} index is the storage-side dedup guard), resolves the
 * recipient from the Patient at consume time, and records the outcome:
 * SENT (+providerMessageId) on transport success, FAILED on transport error,
 * SKIPPED when the Patient has no Contact Email — never a silent drop.
 */
@Injectable()
export class NotificationProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationProcessor.name);
  private worker: Worker<NotificationJob, NotificationOutcome> | undefined;

  constructor(
    @Inject(NOTIFICATIONS_QUEUE) private readonly queue: Queue<NotificationJob>,
    private readonly notificationRepository: NotificationRepository,
    private readonly patientRepository: PatientRepository,
    @Inject(NOTIFICATION_CHANNEL) private readonly channel: NotificationChannel,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<NotificationJob, NotificationOutcome>(
      this.queue.name,
      (job: Job<NotificationJob>) => this.process(job),
      {
        connection: new Redis(loadConfig().redisUrl, { maxRetriesPerRequest: null }),
      },
    );
  }

  async process(job: Job<NotificationJob>): Promise<NotificationOutcome> {
    const { type, refId, patientId } = this.describe(job);
    const context = { organizationId: job.data.organizationId };

    const receipt = await this.notificationRepository.claim(context, type, refId);
    if (!receipt) {
      // Storage-side dedup hit: a receipt already exists, so deliver nothing.
      return { status: 'DEDUPED' };
    }
    const receiptId = String(receipt._id);

    // Recipient resolved at consume time, not carried in the payload: a Patient
    // whose Contact Email changed (or was removed) since enqueue is honoured.
    const patient = await this.patientRepository.findOne(context, { _id: patientId });
    const recipient = patient?.contactEmail;
    if (!patient || !recipient) {
      await this.notificationRepository.markSkipped(context, receiptId);
      this.logger.log(`Notification ${type}/${refId} SKIPPED: no Contact Email`);
      return { status: 'SKIPPED' };
    }

    try {
      const { providerMessageId } = await this.channel.send(
        this.buildMessage(job, patient, recipient),
      );
      await this.notificationRepository.markSent(context, receiptId, recipient, providerMessageId);
      return { status: 'SENT', recipient, providerMessageId };
    } catch (error) {
      // A transport failure is a recorded outcome, not a thrown error: the
      // receipt is FAILED and the job completes (no infinite retry loop).
      this.logger.warn(`Notification ${type}/${refId} FAILED: ${String(error)}`);
      await this.notificationRepository.markFailed(context, receiptId, recipient);
      return { status: 'FAILED', recipient };
    }
  }

  private describe(job: Job<NotificationJob>): JobDescriptor {
    switch (job.name) {
      case PATIENT_CREATED_JOB: {
        const data = job.data as PatientCreatedJob;
        return { type: 'patient.created', refId: data.patientId, patientId: data.patientId };
      }
      case APPOINTMENT_CREATED_JOB: {
        const data = job.data as AppointmentCreatedJob;
        return {
          type: 'appointment.created',
          refId: data.appointmentId,
          patientId: data.patientId,
        };
      }
      case APPOINTMENT_REMINDER_JOB: {
        const data = job.data as AppointmentReminderJob;
        return {
          type: 'appointment.reminder',
          refId: data.appointmentId,
          patientId: data.patientId,
        };
      }
      default:
        throw new Error(`Unknown notification job: ${job.name}`);
    }
  }

  private buildMessage(
    job: Job<NotificationJob>,
    patient: PatientDoc,
    recipient: string,
  ): NotificationMessage {
    const name = `${patient.firstName} ${patient.lastName}`;
    switch (job.name) {
      case APPOINTMENT_CREATED_JOB: {
        const data = job.data as AppointmentCreatedJob;
        return {
          to: recipient,
          subject: 'Appointment confirmation',
          text: `Hello ${name}, your appointment is booked for ${new Date(data.start).toUTCString()}.`,
        };
      }
      case APPOINTMENT_REMINDER_JOB: {
        const data = job.data as AppointmentReminderJob;
        return {
          to: recipient,
          subject: 'Appointment reminder',
          text: `Hello ${name}, this is a reminder for your appointment at ${new Date(data.start).toUTCString()}.`,
        };
      }
      default:
        return {
          to: recipient,
          subject: 'Your CareOps patient record',
          text: `Hello ${name}, your patient record has been created.`,
        };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
