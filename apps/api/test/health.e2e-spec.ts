import request from 'supertest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { setupE2eApp } from './mongo.js';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;
  let mongo: MongoMemoryReplSet;

  beforeAll(async () => {
    ({ app, mongo } = await setupE2eApp('careops-test'));
  });

  afterAll(async () => {
    await app.close();
    await mongo.stop();
  });

  it('GET /api/health reports ok with connected stores', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok', service: 'careops-api', mongo: 'up', redis: 'up' });
  });
});
