import { Module } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { HealthController } from './health.controller.js';
import { HealthService, MONGO_DB_ACCESSOR } from './health.service.js';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: MONGO_DB_ACCESSOR,
      inject: [getConnectionToken()],
      useFactory: (connection: Connection) => ({ db: () => connection.db }),
    },
  ],
})
export class HealthModule {}
