import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { bootstrapApi } from '../src/bootstrap-api.js';
import { createTestMongo } from './mongo.js';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;
  let mongo: MongoMemoryReplSet;

  beforeAll(async () => {
    mongo = await createTestMongo();
    process.env.MONGODB_URI = mongo.getUri('careops-test');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    bootstrapApi(app);
    await app.init();
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
