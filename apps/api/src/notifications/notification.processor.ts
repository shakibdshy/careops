import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { loadConfig } from '../config/env.js';
import { NOTIFICATIONS_QUEUE } from './notifications.tokens.js';
import type { PatientCreatedJob } from './notifications.tokens.js';

/**
 * Delivery is stubbed in week 1 (logged); week 2 swaps in real email. The
 * job id is the idempotency key (notifications.tokens.ts) — in-flight
 * duplicates collapse; week 2 pairs it with storage-side dedup for real
 * side effects.
 */
@Injectable()
export class NotificationProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationProcessor.name);
  private worker: Worker<PatientCreatedJob> | undefined;

  constructor(@Inject(NOTIFICATIONS_QUEUE) private readonly queue: Queue<PatientCreatedJob>) {}

  onModuleInit(): void {
    this.worker = new Worker<PatientCreatedJob>(
      this.queue.name,
      (job: Job<PatientCreatedJob>) => Promise.resolve(this.process(job)),
      {
        connection: new Redis(loadConfig().redisUrl, { maxRetriesPerRequest: null }),
      },
    );
  }

  process(job: Job<PatientCreatedJob>): { delivered: boolean; to: string } {
    // STUB delivery — week 2 replaces this with the email transport.
    this.logger.log(
      `patient.created notification (stub) for ${job.data.patientName} in org ${job.data.organizationId}`,
    );
    return { delivered: true, to: `org-${job.data.organizationId}@notifications.stub` };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
