import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HealthModule } from './health/health.module.js';
import { RedisModule } from './redis/redis.module.js';
import { WorkspaceModule } from './workspace/workspace.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { PatientsModule } from './patients/patients.module.js';
import { AuditModule } from './audit/audit.module.js';
import { loadConfig } from './config/env.js';
import { closeAuth } from './auth/auth.instance.js';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: () => ({ uri: loadConfig().mongoUri }),
    }),
    RedisModule,
    AuditModule,
    HealthModule,
    WorkspaceModule,
    OrganizationsModule,
    PatientsModule,
  ],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await closeAuth();
  }
}
