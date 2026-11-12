import { Test } from '@nestjs/testing';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Db } from 'mongodb';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { bootstrapApi } from '../src/bootstrap-api.js';
import { MONGO_DB_ACCESSOR, type MongoDbAccessor } from '../src/health/health.service.js';
import { createTestMongo } from './mongo.js';

function requireDb(mongo: MongoDbAccessor): Db {
  const db = mongo.db();
  if (!db) {
    throw new Error('Mongo db handle unavailable');
  }
  return db;
}

describe('Transactions (e2e)', () => {
  let app: INestApplication<App>;
  let mongo: MongoMemoryReplSet;

  beforeAll(async () => {
    mongo = await createTestMongo();
    process.env.MONGODB_URI = mongo.getUri('careops-tx-test');

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

  it('commits a transaction spanning two collections', async () => {
    const db = requireDb(app.get<MongoDbAccessor>(MONGO_DB_ACCESSOR));
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        await db
          .collection<{ _id: string; side: string }>('tx_a')
          .insertOne({ _id: 'shared', side: 'a' }, { session });
        await db
          .collection<{ _id: string; side: string }>('tx_b')
          .insertOne({ _id: 'shared', side: 'b' }, { session });
      });
    } finally {
      await session.endSession();
    }

    expect(await db.collection('tx_a').countDocuments()).toBe(1);
    expect(await db.collection('tx_b').countDocuments()).toBe(1);
  });

  it('rolls back every write when the transaction aborts', async () => {
    const db = requireDb(app.get<MongoDbAccessor>(MONGO_DB_ACCESSOR));
    const session = db.client.startSession();
    const run = session.withTransaction(async () => {
      await db
        .collection<{ _id: string; side: string }>('tx_a')
        .insertOne({ _id: 'doomed', side: 'a' }, { session });
      throw new Error('boom');
    });
    await expect(run).rejects.toThrow('boom');
    await session.endSession();

    expect(await db.collection('tx_a').countDocuments()).toBe(1);
  });
});
