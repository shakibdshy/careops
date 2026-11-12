import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { bootstrapApi } from '../src/bootstrap-api.js';
import { NOTIFICATION_CHANNEL } from '../src/notifications/notification-channel.js';
import type { NotificationChannel } from '../src/notifications/notification-channel.js';
import { RecordingNotificationChannel } from './fake-notification-channel.js';

// Every e2e suite boots Mongo as a single-node replica set: the appointments
// domain (and any future multi-document write) needs transactions, which a
// standalone mongod refuses ("does not support retryable writes"). One helper
// keeps the topology a config change, not a per-file decision.
async function createTestMongo(): Promise<MongoMemoryReplSet> {
  return MongoMemoryReplSet.create({ replSet: { count: 1, name: 'rs0' } });
}

export interface E2eHarness {
  app: INestApplication<App>;
  mongo: MongoMemoryReplSet;
  close(): Promise<void>;
}

export interface E2eOverrides {
  /** Delivery seam; defaults to a recording fake so no e2e touches SMTP. */
  channel?: NotificationChannel;
}

// Boots the full API (module wiring + bootstrap + init) against a fresh
// single-node replica set, so each suite states only what makes it different
// (db name, agents, seed requests) instead of repeating the harness.
export async function setupE2eApp(
  dbName: string,
  overrides: E2eOverrides = {},
): Promise<E2eHarness> {
  const mongo = await createTestMongo();
  process.env.MONGODB_URI = mongo.getUri(dbName);
  // Isolate each suite's BullMQ queue: e2e files run in parallel against one
  // Redis, so a shared queue name would let one suite's worker consume another's
  // notification jobs and write receipts into the wrong database.
  process.env.NOTIFICATIONS_QUEUE_NAME = `notifications-${dbName}`;

  const channel = overrides.channel ?? new RecordingNotificationChannel();
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(NOTIFICATION_CHANNEL)
    .useValue(channel)
    .compile();
  const app: INestApplication<App> = moduleFixture.createNestApplication({
    bodyParser: false,
  });
  bootstrapApi(app);
  await app.init();

  return {
    app,
    mongo,
    close: async () => {
      await app.close();
      await mongo.stop();
    },
  };
}
