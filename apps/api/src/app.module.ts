import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HealthModule } from './health/health.module.js';
import { RedisModule } from './redis/redis.module.js';
import { WorkspaceModule } from './workspace/workspace.module.js';
import { loadConfig } from './config/env.js';
import { closeAuth } from './auth/auth.instance.js';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: () => ({ uri: loadConfig().mongoUri }),
    }),
    RedisModule,
    HealthModule,
    WorkspaceModule,
  ],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await closeAuth();
  }
}
