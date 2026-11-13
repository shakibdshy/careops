import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters (generate: openssl rand -base64 32)'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // SMTP transport for notification delivery. Defaults point at the Mailpit
  // container in docker compose, so boot is self-contained with zero external
  // keys; production overrides SMTP_URL with a real relay.
  SMTP_URL: z.string().min(1).default('smtp://localhost:1025'),
  MAIL_FROM: z.string().min(1).default('CareOps <no-reply@careops.local>'),
  // BullMQ queue name. Overridden per e2e suite so parallel workers never
  // cross-process each other's jobs against the wrong database.
  NOTIFICATIONS_QUEUE_NAME: z.string().min(1).default('notifications'),
  // Same-origin deployment (W3-T4): the public app origin (CloudFront/ALB
  // domain). Drives better-auth's cookie policy — an https origin yields
  // Secure cookies; an http origin (local proofs) yields non-Secure ones.
  BETTER_AUTH_URL: z.string().min(1).optional(),
  // Comma-separated extra origins better-auth may receive signed-in requests
  // from. Production defaults to none; the deploy sets it to the app origin.
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Validated, app-facing config derived from the env schema. */
export type AppConfig = {
  port: number;
  mongoUri: string;
  redisUrl: string;
  betterAuthSecret: string;
  nodeEnv: Env['NODE_ENV'];
  smtpUrl: string;
  mailFrom: string;
  notificationsQueueName: string;
  betterAuthUrl?: string;
  trustedOrigins: string[];
};

export class EnvValidationError extends Error {
  constructor(envName: string, cause: string) {
    super(`Invalid environment: ${envName} — ${cause}`);
    this.name = 'EnvValidationError';
  }
}

export function validateEnv(raw: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    // A failed safeParse always carries at least one issue; object-schema
    // issue paths are never empty, so the variable name is always present.
    const first = result.error.issues[0]!;
    throw new EnvValidationError(first.path.join('.'), first.message);
  }
  return {
    port: result.data.PORT,
    mongoUri: result.data.MONGODB_URI,
    redisUrl: result.data.REDIS_URL,
    betterAuthSecret: result.data.BETTER_AUTH_SECRET,
    nodeEnv: result.data.NODE_ENV,
    smtpUrl: result.data.SMTP_URL,
    mailFrom: result.data.MAIL_FROM,
    notificationsQueueName: result.data.NOTIFICATIONS_QUEUE_NAME,
    // Spread-guard, not `| undefined`: exactOptionalPropertyTypes is on.
    ...(result.data.BETTER_AUTH_URL ? { betterAuthUrl: result.data.BETTER_AUTH_URL } : {}),
    trustedOrigins: (result.data.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  };
}

let cachedConfig: AppConfig | undefined;

/**
 * Reads and validates the process environment once per process.
 * Called at module-init time (e.g. forRootAsync factories) so a
 * misconfigured deployment fails at boot, naming the variable.
 */
export function loadConfig(): AppConfig {
  cachedConfig ??= validateEnv(process.env);
  return cachedConfig;
}
