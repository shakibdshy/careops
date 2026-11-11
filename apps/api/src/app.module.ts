import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HealthModule } from './health/health.module.js';
import { RedisModule } from './redis/redis.module.js';
import { loadConfig } from './config/env.js';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: () => ({ uri: loadConfig().mongoUri }),
    }),
    RedisModule,
    HealthModule,
  ],
})
export class AppModule {}
