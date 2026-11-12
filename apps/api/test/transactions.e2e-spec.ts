import { getConnectionToken } from '@nestjs/mongoose';
import type { Db } from 'mongodb';
import type { Connection } from 'mongoose';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { setupE2eApp, type E2eHarness } from './mongo.js';

interface TxDoc {
  _id: string;
  side: string;
}

describe('Transactions (e2e)', () => {
  let app: INestApplication<App>;
  let db: Db;
  let harness: E2eHarness;

  beforeAll(async () => {
    harness = await setupE2eApp('careops-tx-test');
    app = harness.app;

    const connection = app.get<Connection>(getConnectionToken());
    if (!connection.db) {
      throw new Error('Mongo db handle unavailable');
    }
    db = connection.db;
  });

  afterAll(async () => {
    await harness.close();
  });

  it('commits a transaction spanning two collections', async () => {
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        await db
          .collection<TxDoc>('tx_commit_a')
          .insertOne({ _id: 'shared', side: 'a' }, { session });
        await db
          .collection<TxDoc>('tx_commit_b')
          .insertOne({ _id: 'shared', side: 'b' }, { session });
      });
    } finally {
      await session.endSession();
    }

    expect(await db.collection('tx_commit_a').countDocuments()).toBe(1);
    expect(await db.collection('tx_commit_b').countDocuments()).toBe(1);
  });

  it('rolls back every write when the transaction aborts', async () => {
    const session = db.client.startSession();
    const run = session.withTransaction(async () => {
      await db
        .collection<TxDoc>('tx_rollback')
        .insertOne({ _id: 'doomed', side: 'a' }, { session });
      throw new Error('boom');
    });
    try {
      await expect(run).rejects.toThrow('boom');
    } finally {
      await session.endSession();
    }

    expect(await db.collection('tx_rollback').countDocuments()).toBe(0);
  });
});
