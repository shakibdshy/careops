import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HealthModule } from './health/health.module.js';
import { RedisModule } from './redis/redis.module.js';
import { WorkspaceModule } from './workspace/workspace.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { PatientsModule } from './patients/patients.module.js';
import { AppointmentsModule } from './appointments/appointments.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { AuditModule } from './audit/audit.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { loadConfig } from './config/env.js';
import { closeAuth } from './auth/auth.instance.js';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: () => ({ uri: loadConfig().mongoUri }),
    }),
    RedisModule,
    NotificationsModule,
    AuditModule,
    HealthModule,
    WorkspaceModule,
    OrganizationsModule,
    PatientsModule,
    AppointmentsModule,
    ReportsModule,
  ],
})
export class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await closeAuth();
  }
}
