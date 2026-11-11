import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { loadConfig } from '../config/env.js';
import { NOTIFICATIONS_QUEUE, type PatientCreatedJob } from './notifications.tokens.js';
import { NotificationProcessor } from './notification.processor.js';

/** Producer side of the queue-backed side effects (week 2 grows consumers). */
@Global()
@Module({
  providers: [
    {
      provide: NOTIFICATIONS_QUEUE,
      useFactory: (): Queue<PatientCreatedJob> =>
        new Queue<PatientCreatedJob>('notifications', {
          connection: new Redis(loadConfig().redisUrl, { maxRetriesPerRequest: null }),
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 500 },
            removeOnComplete: 100,
            removeOnFail: 500,
          },
        }),
    },
    NotificationProcessor,
  ],
  exports: [NOTIFICATIONS_QUEUE],
})
export class NotificationsModule implements OnApplicationShutdown {
  constructor(@Inject(NOTIFICATIONS_QUEUE) private readonly queue: Queue<PatientCreatedJob>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
