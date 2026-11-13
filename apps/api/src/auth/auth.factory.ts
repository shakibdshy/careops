import type { MongoClient } from 'mongodb';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { openAPI, organization } from 'better-auth/plugins';
import type { AppConfig } from '../config/env.js';

/**
 * The BetterAuth configuration shared by the API process and the seed
 * script: the org-creation database hook (T4) MUST be part of it, or seeded
 * signups produce users without an Organization.
 */
export function createBetterAuth(config: AppConfig, client: MongoClient) {
  const auth = betterAuth({
    secret: config.betterAuthSecret,
    // The public app origin (CloudFront/ALB domain in a deploy, the local
    // origin in proofs). better-auth derives the cookie policy from it: https
    // origins get Secure cookies, http origins do not — so the same-origin
    // session works behind plain-HTTP test origins too.
    ...(config.betterAuthUrl ? { baseURL: config.betterAuthUrl } : {}),
    database: mongodbAdapter(client.db()),
    emailAndPassword: {
      enabled: true,
    },
    // Tenant boundary per the glossary: every User lands in exactly one
    // Organization as its owner (ADR-0006). Invitations and roles come from
    // the plugin. System action — no session exists during signup, so no
    // headers may be passed.
    // openAPI() exposes GET /api/reference (Scalar UI) documenting every auth endpoint.
    plugins: [organization(), openAPI()],
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; name: string }) => {
            await auth.api.createOrganization({
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
    // Deployments name their app origin (BETTER_AUTH_TRUSTED_ORIGINS / the
    // origin itself via BETTER_AUTH_URL); dev trusts the local web dev server.
    trustedOrigins: [
      ...(config.nodeEnv === 'production' ? [] : ['http://localhost:3000']),
      ...config.trustedOrigins,
      ...(config.betterAuthUrl ? [config.betterAuthUrl] : []),
    ],
  });
  return auth;
}
