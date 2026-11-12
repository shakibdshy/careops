import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppointmentDocument, AppointmentModelSchema } from '../appointments/appointment.schema.js';
import { ReportsCacheModule } from './reports-cache.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsRepository } from './reports.repository.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: AppointmentDocument.name, schema: AppointmentModelSchema }]),
    ReportsCacheModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsRepository, ReportsService],
})
export class ReportsModule {}
