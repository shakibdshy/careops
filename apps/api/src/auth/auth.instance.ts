import { MongoClient } from 'mongodb';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { loadConfig } from '../config/env.js';

let instance: ReturnType<typeof createAuth> | undefined;

/**
 * The BetterAuth instance. Auth tables are owned by BetterAuth's official
 * MongoDB adapter (native driver) per ADR-0004 — they are never modeled in
 * Mongoose. The client is process-scoped; the connection pools alongside the
 * Mongoose pool against the same database.
 */
export function getAuth(): ReturnType<typeof createAuth> {
  instance ??= createAuth();
  return instance;
}

function createAuth() {
  const config = loadConfig();
  const client = new MongoClient(config.mongoUri);
  const db = client.db();
  return betterAuth({
    secret: config.betterAuthSecret,
    database: mongodbAdapter(db),
    emailAndPassword: {
      enabled: true,
    },
    trustedOrigins: config.nodeEnv === 'production' ? [] : ['http://localhost:3000'],
  });
}

export type CareOpsAuth = ReturnType<typeof createAuth>;
/** The verified BetterAuth session: `{ session, user }`. */
export type CareOpsSession = CareOpsAuth['$Infer']['Session'];
