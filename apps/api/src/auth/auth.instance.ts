import { MongoClient } from 'mongodb';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { organization } from 'better-auth/plugins';
import { loadConfig } from '../config/env.js';

let instance: ReturnType<typeof createAuth> | undefined;
let client: MongoClient | undefined;

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

/** Closes the auth database connection (process shutdown / test teardown). */
export async function closeAuth(): Promise<void> {
  await client?.close();
  client = undefined;
  instance = undefined;
}

function createAuth() {
  const config = loadConfig();
  client = new MongoClient(config.mongoUri);
  const db = client.db();
  return betterAuth({
    secret: config.betterAuthSecret,
    database: mongodbAdapter(db),
    emailAndPassword: {
      enabled: true,
    },
    // Tenant boundary per the glossary: every User lands in exactly one
    // Organization as its owner (ADR-0006 discriminator-key tenancy builds on
    // this invariant in T5). Invitations and roles come from the plugin.
    plugins: [organization()],
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; name: string }) => {
            // System action: no session exists yet, so no request headers may
            // be passed (better-auth rejects header-bearing calls without a
            // session). userId marks this as a server-side action. Active-
            // organization resolution happens at read time in OrgContextGuard.
            await getAuth().api.createOrganization({
              body: {
                name: `${user.name}'s Organization`,
                slug: `org-${user.id}`,
                userId: user.id,
              },
            });
          },
        },
      },
    },
    trustedOrigins: config.nodeEnv === 'production' ? [] : ['http://localhost:3000'],
  });
}

export type CareOpsAuth = ReturnType<typeof createAuth>;
/** The verified BetterAuth session: `{ session, user }`. */
export type CareOpsSession = CareOpsAuth['$Infer']['Session'];
