import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { loadConfig } from '../config/env.js';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis =>
        new Redis(loadConfig().redisUrl, {
          // Keep retrying with capped backoff: compose may still be starting
          // Redis when the API boots. Health probes are timeout-guarded, so a
          // not-yet-ready Redis renders as "down" instead of hanging requests.
          maxRetriesPerRequest: null,
          retryStrategy: (times: number) => Math.min(times * 200, 2000),
        }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
