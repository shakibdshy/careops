import { validateEnv } from './env.js';

describe('validateEnv', () => {
  const validEnv = {
    PORT: '3001',
    MONGODB_URI: 'mongodb://localhost:27017/careops',
    REDIS_URL: 'redis://localhost:6379',
    NODE_ENV: 'development',
  };

  it('parses a complete environment into typed config', () => {
    const config = validateEnv(validEnv);
    expect(config).toEqual({
      port: 3001,
      mongoUri: 'mongodb://localhost:27017/careops',
      redisUrl: 'redis://localhost:6379',
      nodeEnv: 'development',
    });
  });

  it('applies defaults for PORT and NODE_ENV', () => {
    const config = validateEnv({
      MONGODB_URI: 'mongodb://localhost:27017/careops',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(config.port).toBe(3001);
    expect(config.nodeEnv).toBe('development');
  });

  it('fails fast naming the missing variable', () => {
    const missingMongo = { ...validEnv } as Record<string, string>;
    delete missingMongo.MONGODB_URI;
    expect(() => validateEnv(missingMongo)).toThrow(/MONGODB_URI/);
  });

  it('fails fast naming the invalid variable', () => {
    expect(() => validateEnv({ ...validEnv, PORT: 'not-a-port' })).toThrow(/PORT/);
  });
});
