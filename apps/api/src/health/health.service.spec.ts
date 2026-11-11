import type { Db } from 'mongodb';
import type Redis from 'ioredis';
import { HealthService, type MongoDbAccessor } from './health.service.js';

function fakeRedis(ping: () => Promise<string>): Redis {
  return { ping } as unknown as Redis;
}

function fakeMongoAccessor(up: boolean): MongoDbAccessor {
  const command = up
    ? (): Promise<Record<string, unknown>> => Promise.resolve({ ok: 1 })
    : (): Promise<Record<string, unknown>> => Promise.reject(new Error('connection refused'));
  return { db: () => ({ admin: () => ({ command }) }) as unknown as Db };
}

describe('HealthService', () => {
  it('reports ok with both stores reachable', async () => {
    const service = new HealthService(
      fakeRedis(() => Promise.resolve('PONG')),
      fakeMongoAccessor(true),
    );
    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      service: 'careops-api',
      mongo: 'up',
      redis: 'up',
    });
  });

  it('reports degraded when mongo is unreachable', async () => {
    const service = new HealthService(
      fakeRedis(() => Promise.resolve('PONG')),
      fakeMongoAccessor(false),
    );
    await expect(service.check()).resolves.toEqual({
      status: 'degraded',
      service: 'careops-api',
      mongo: 'down',
      redis: 'up',
    });
  });

  it('reports degraded when redis is unreachable', async () => {
    const service = new HealthService(
      fakeRedis(() => Promise.reject(new Error('down'))),
      fakeMongoAccessor(true),
    );
    await expect(service.check()).resolves.toEqual({
      status: 'degraded',
      service: 'careops-api',
      mongo: 'up',
      redis: 'down',
    });
  });

  it('reports degraded when mongo is not connected yet', async () => {
    const service = new HealthService(
      fakeRedis(() => Promise.resolve('PONG')),
      { db: () => null },
    );
    await expect(service.check()).resolves.toEqual({
      status: 'degraded',
      service: 'careops-api',
      mongo: 'down',
      redis: 'up',
    });
  });
});
