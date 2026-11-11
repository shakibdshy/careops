import { Inject, Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import type Redis from 'ioredis';
import type { HealthResponse } from '@careops/shared';
import { REDIS_CLIENT } from '../redis/redis.module.js';

const PING_TIMEOUT_MS = 500;

export const MONGO_DB_ACCESSOR = Symbol('MONGO_DB_ACCESSOR');

/** Indirection over the live Mongo handle so tests can inject a fake. */
export interface MongoDbAccessor {
  db(): Db | null | undefined;
}

async function reachable(promise: Promise<unknown>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(MONGO_DB_ACCESSOR) private readonly mongo: MongoDbAccessor,
  ) {}

  async check(): Promise<HealthResponse> {
    const [mongoUp, redisUp] = await Promise.all([this.checkMongo(), this.checkRedis()]);
    return {
      status: mongoUp && redisUp ? 'ok' : 'degraded',
      service: 'careops-api',
      mongo: mongoUp ? 'up' : 'down',
      redis: redisUp ? 'up' : 'down',
    };
  }

  private async checkMongo(): Promise<boolean> {
    const db = this.mongo.db();
    if (!db) {
      return false;
    }
    return reachable(db.admin().command({ ping: 1 }));
  }

  private async checkRedis(): Promise<boolean> {
    return reachable(this.redis.ping());
  }
}
