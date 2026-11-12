import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module.js';

/**
 * Cache-aside for the read-heavy reports (W2-T7, ADR-0011). Entry keys embed a
 * per-organization generation counter that every Appointment write bumps, so
 * invalidation is instant and O(1) — no key scans, no stale reads after a
 * booking. A TTL is the backstop: a missed bump self-heals when the entry
 * expires. Redis is a boundary, so cache failures degrade to a fresh compute
 * and never fail a request or an already-committed write.
 */
@Injectable()
export class ReportsCache {
  private readonly logger = new Logger(ReportsCache.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Advance the org's report generation; the next read recomputes under a new key. */
  async bumpGeneration(organizationId: string): Promise<void> {
    try {
      await this.redis.incr(`reports:gen:${organizationId}`);
    } catch (error) {
      this.logger.warn(`Could not bump report generation: ${String(error)}`);
    }
  }

  /**
   * Read-through cache-aside: `compute` runs only on a miss, and the fresh
   * value is stored under the current generation with a TTL backstop.
   */
  async wrap<T>(
    organizationId: string,
    report: string,
    days: number,
    ttlSeconds: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const key = await this.currentKey(organizationId, report, days);
    if (key !== null) {
      const cached = await this.read<T>(key);
      if (cached !== null) {
        return cached;
      }
    }
    const fresh = await compute();
    if (key !== null) {
      await this.store(key, fresh, ttlSeconds);
    }
    return fresh;
  }

  private async currentKey(
    organizationId: string,
    report: string,
    days: number,
  ): Promise<string | null> {
    try {
      const generation = (await this.redis.get(`reports:gen:${organizationId}`)) ?? '0';
      return `reports:${organizationId}:${generation}:${report}:${days}`;
    } catch (error) {
      this.logger.warn(`Could not read report generation: ${String(error)}`);
      return null;
    }
  }

  private async read<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (error) {
      this.logger.warn(`Could not read report cache: ${String(error)}`);
      return null;
    }
  }

  private async store<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn(`Could not write report cache: ${String(error)}`);
    }
  }
}
