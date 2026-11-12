import { MongoMemoryReplSet } from 'mongodb-memory-server';

// Every e2e suite boots Mongo as a single-node replica set: the appointments
// domain (and any future multi-document write) needs transactions, which a
// standalone mongod refuses ("does not support retryable writes"). One helper
// keeps the topology a config change, not a per-file decision.
export async function createTestMongo(): Promise<MongoMemoryReplSet> {
  return MongoMemoryReplSet.create({ replSet: { count: 1, name: 'rs0' } });
}
