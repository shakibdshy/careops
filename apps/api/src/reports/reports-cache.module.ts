import { Module } from '@nestjs/common';
import { ReportsCache } from './reports.cache.js';

/**
 * Shared so the reporting reads and the Appointment writes that invalidate
 * them use one cache instance. RedisModule is @Global, so REDIS_CLIENT is
 * injectable here without an explicit import.
 */
@Module({
  providers: [ReportsCache],
  exports: [ReportsCache],
})
export class ReportsCacheModule {}
