// Dumps the committed API contract (packages/contract/openapi/): the NestJS
// domain document served at /api/docs-json plus the BetterAuth document
// served at /api/auth/open-api/generate-schema — from the SAME boot the e2e
// suites use (bootstrapApi + ephemeral replica set), so the artifacts cannot
// drift from what the API actually serves.
//
// This runs from the COMPILED output (`bun run dump:openapi` → nest build +
// node dist/scripts/…): bun's/tsx's decorator transforms do not emit
// decorator metadata, which @nestjs/mongoose needs to resolve @Prop types —
// only the tsc build (the production artifact) does. Run via
// `bun run contract:generate` at the repo root; CI regenerates and fails on
// any uncommitted difference.
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { bootstrapApi } from '../bootstrap-api.js';
import { NOTIFICATION_CHANNEL } from '../notifications/notification-channel.js';
import type { NotificationChannel } from '../notifications/notification-channel.js';

const OUT_DIR = resolve(process.cwd(), '../../packages/contract/openapi');

function write(name: string, doc: unknown): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, name), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote packages/contract/openapi/${name}`);
}

// The env defaults the e2e harness sets (test/setup-env.ts); the script is
// outside jest, so it states its own. REDIS_URL must point at a live Redis —
// the module connects eagerly (the same requirement the e2e suites have).
process.env.NODE_ENV ??= 'test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-only-for-the-e2e-harness-1234567890';

// No-op delivery seam: dumping documents never notifies anyone, but the
// module requires a channel binding (the e2e harness overrides it the same
// way; the fake lives in test/ which is outside the compiled root).
const noDelivery: NotificationChannel = {
  send: () => Promise.resolve({ providerMessageId: 'dump-openapi-noop' }),
};

// Single-node replica set: the appointments domain needs transactions, which
// a standalone mongod refuses (same topology the e2e harness uses).
const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, name: 'rs0' } });
process.env.MONGODB_URI = mongo.getUri('careops-openapi-dump');
// Isolate the BullMQ queue so a running dev worker can't consume from it.
process.env.NOTIFICATIONS_QUEUE_NAME = 'notifications-openapi-dump';

let app: INestApplication<App> | undefined;
try {
  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(NOTIFICATION_CHANNEL)
    .useValue(noDelivery)
    .compile();
  app = moduleFixture.createNestApplication({ bodyParser: false });
  bootstrapApi(app);
  await app.init();

  const domain: unknown = (await request(app.getHttpServer()).get('/api/docs-json').expect(200))
    .body;
  write('api.json', domain);

  const auth = (
    await request(app.getHttpServer()).get('/api/auth/open-api/generate-schema').expect(200)
  ).body as { servers?: Array<{ url: string }> };
  // Normalize the only volatile field: BetterAuth bakes the booted origin's
  // port into servers[0].url. The contract is origin-independent, so it is
  // pinned to the auth base path (same convention as the domain doc's
  // relative server entry).
  auth.servers = [{ url: '/api/auth' }];
  write('auth.json', auth);
} finally {
  await app?.close();
  await mongo.stop();
  // BetterAuth internals hold timers/pool handles across shutdown (the e2e
  // jest config needs forceExit for the same reason), so the script exits
  // explicitly once the artifacts are on disk.
  process.exit(0);
}
