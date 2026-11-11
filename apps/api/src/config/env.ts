import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  port: number;
  mongoUri: string;
  redisUrl: string;
  nodeEnv: 'development' | 'test' | 'production';
}

export class EnvValidationError extends Error {
  constructor(envName: string, cause: string) {
    super(`Invalid environment: ${envName} — ${cause}`);
    this.name = 'EnvValidationError';
  }
}

export function validateEnv(raw: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    if (!first) {
      throw new EnvValidationError('unknown', 'validation produced no details');
    }
    const envName = first.path.join('.') || 'unknown';
    throw new EnvValidationError(envName, first.message);
  }
  return {
    port: result.data.PORT,
    mongoUri: result.data.MONGODB_URI,
    redisUrl: result.data.REDIS_URL,
    nodeEnv: result.data.NODE_ENV,
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
