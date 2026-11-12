import { validateEnv } from './env.js';

describe('validateEnv', () => {
  const testSecret = 'x'.repeat(32);
  const validEnv = {
    PORT: '3001',
    MONGODB_URI: 'mongodb://localhost:27017/careops',
    REDIS_URL: 'redis://localhost:6379',
    BETTER_AUTH_SECRET: testSecret,
    NODE_ENV: 'development',
  };

  it('parses a complete environment into typed config', () => {
    const config = validateEnv(validEnv);
    expect(config).toEqual({
      port: 3001,
      mongoUri: 'mongodb://localhost:27017/careops',
      redisUrl: 'redis://localhost:6379',
      betterAuthSecret: testSecret,
      nodeEnv: 'development',
      smtpUrl: 'smtp://localhost:1025',
      mailFrom: 'CareOps <no-reply@careops.local>',
      notificationsQueueName: 'notifications',
    });
  });

  it('defaults SMTP, mail-from, and queue name for self-contained boot', () => {
    const config = validateEnv({
      MONGODB_URI: 'mongodb://localhost:27017/careops',
      REDIS_URL: 'redis://localhost:6379',
      BETTER_AUTH_SECRET: testSecret,
    });
    expect(config.smtpUrl).toBe('smtp://localhost:1025');
    expect(config.mailFrom).toBe('CareOps <no-reply@careops.local>');
    expect(config.notificationsQueueName).toBe('notifications');
  });

  it('honours SMTP, mail-from, and queue-name overrides', () => {
    const config = validateEnv({
      ...validEnv,
      SMTP_URL: 'smtp://relay.example.test:587',
      MAIL_FROM: 'Clinic <care@example.test>',
      NOTIFICATIONS_QUEUE_NAME: 'notifications-custom',
    });
    expect(config.smtpUrl).toBe('smtp://relay.example.test:587');
    expect(config.mailFrom).toBe('Clinic <care@example.test>');
    expect(config.notificationsQueueName).toBe('notifications-custom');
  });

  it('applies defaults for PORT and NODE_ENV', () => {
    const config = validateEnv({
      MONGODB_URI: 'mongodb://localhost:27017/careops',
      REDIS_URL: 'redis://localhost:6379',
      BETTER_AUTH_SECRET: testSecret,
    });
    expect(config.port).toBe(3001);
    expect(config.nodeEnv).toBe('development');
  });

  it('fails fast naming the missing variable', () => {
    const missingMongo = { ...validEnv } as Record<string, string>;
    delete missingMongo.MONGODB_URI;
    expect(() => validateEnv(missingMongo)).toThrow(/MONGODB_URI/);
  });

  it('fails fast naming the missing auth secret', () => {
    const missingSecret = { ...validEnv } as Record<string, string>;
    delete missingSecret.BETTER_AUTH_SECRET;
    expect(() => validateEnv(missingSecret)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it('fails fast naming the invalid variable', () => {
    expect(() => validateEnv({ ...validEnv, PORT: 'not-a-port' })).toThrow(/PORT/);
  });

  it('rejects an auth secret shorter than 32 characters', () => {
    expect(() => validateEnv({ ...validEnv, BETTER_AUTH_SECRET: 'too-short' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });
});

describe('loadConfig', () => {
  const envKeys = [
    'PORT',
    'MONGODB_URI',
    'REDIS_URL',
    'BETTER_AUTH_SECRET',
    'NODE_ENV',
    'SMTP_URL',
    'MAIL_FROM',
    'NOTIFICATIONS_QUEUE_NAME',
  ] as const;

  afterEach(() => {
    jest.resetModules();
  });

  it('validates process.env once and caches the config', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of envKeys) {
      saved[key] = process.env[key];
    }
    process.env.MONGODB_URI = 'mongodb://localhost:27017/cached';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.BETTER_AUTH_SECRET = 'x'.repeat(32);
    process.env.PORT = '3123';
    try {
      const { loadConfig } = await import('./env.js');
      const first = loadConfig();
      const second = loadConfig();
      expect(second).toBe(first);
      expect(first.port).toBe(3123);
    } finally {
      for (const key of envKeys) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  });

  it('fails at boot naming the missing variable', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.BETTER_AUTH_SECRET = 'x'.repeat(32);
    try {
      const { loadConfig } = await import('./env.js');
      expect(() => loadConfig()).toThrow(/MONGODB_URI/);
    } finally {
      for (const key of envKeys) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  });
});
