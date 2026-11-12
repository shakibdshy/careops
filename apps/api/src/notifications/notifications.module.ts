import { Global, Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { loadConfig } from '../config/env.js';
import { PatientDocument, PatientModelSchema } from '../patients/patient.schema.js';
import { PatientRepository } from '../patients/patient.repository.js';
import { NotificationDocument, NotificationModelSchema } from './notification.schema.js';
import { NotificationRepository } from './notification.repository.js';
import { NOTIFICATION_CHANNEL } from './notification-channel.js';
import { SmtpNotificationChannel } from './smtp-notification.channel.js';
import { NOTIFICATIONS_QUEUE } from './notifications.tokens.js';
import type { NotificationJob } from './notifications.tokens.js';
import { NotificationProcessor } from './notification.processor.js';

/**
 * Queue-backed notification delivery (ticket #29). @Global so the Patient and
 * Appointment producers inject NOTIFICATIONS_QUEUE without an explicit import.
 * The channel is the SMTP implementation in production; e2e overrides the
 * NOTIFICATION_CHANNEL provider with a recording fake so no test hits a network.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: NotificationDocument.name, schema: NotificationModelSchema },
      // The processor resolves the recipient from the Patient at consume time.
      { name: PatientDocument.name, schema: PatientModelSchema },
    ]),
  ],
  providers: [
    {
      provide: NOTIFICATIONS_QUEUE,
      useFactory: (): Queue<NotificationJob> =>
        new Queue<NotificationJob>(loadConfig().notificationsQueueName, {
          connection: new Redis(loadConfig().redisUrl, { maxRetriesPerRequest: null }),
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 500 },
            removeOnComplete: 100,
            removeOnFail: 500,
          },
        }),
    },
    { provide: NOTIFICATION_CHANNEL, useClass: SmtpNotificationChannel },
    NotificationRepository,
    PatientRepository,
    NotificationProcessor,
  ],
  exports: [NOTIFICATIONS_QUEUE],
})
export class NotificationsModule implements OnApplicationShutdown {
  constructor(@Inject(NOTIFICATIONS_QUEUE) private readonly queue: Queue<NotificationJob>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
