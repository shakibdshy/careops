import { MongoClient } from 'mongodb';
import { loadConfig } from '../config/env.js';
import { createBetterAuth } from './auth.factory.js';

let instance: ReturnType<typeof createBetterAuth> | undefined;
let client: MongoClient | undefined;

/**
 * The BetterAuth instance. Auth tables are owned by BetterAuth's official
 * MongoDB adapter (native driver) per ADR-0004 — they are never modeled in
 * Mongoose. The client is process-scoped; the connection pools alongside the
 * Mongoose pool against the same database.
 */
export function getAuth(): ReturnType<typeof createBetterAuth> {
  if (!instance) {
    client = new MongoClient(loadConfig().mongoUri);
    instance = createBetterAuth(loadConfig(), client);
  }
  return instance;
}

/** Closes the auth database connection (process shutdown / test teardown). */
export async function closeAuth(): Promise<void> {
  await client?.close();
  client = undefined;
  instance = undefined;
}

export type CareOpsAuth = ReturnType<typeof createBetterAuth>;
/** The verified BetterAuth session: `{ session, user }`. */
export type CareOpsSession = CareOpsAuth['$Infer']['Session'];
