import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module.js';
import { ReportsCacheModule } from '../reports/reports-cache.module.js';
import { PatientDocument, PatientModelSchema } from '../patients/patient.schema.js';
import { PatientRepository } from '../patients/patient.repository.js';
import { AppointmentDocument, AppointmentModelSchema } from './appointment.schema.js';
import {
  ProviderScheduleDocument,
  ProviderScheduleModelSchema,
} from './provider-schedule.schema.js';
import { AppointmentRepository } from './appointment.repository.js';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AppointmentDocument.name, schema: AppointmentModelSchema },
      { name: ProviderScheduleDocument.name, schema: ProviderScheduleModelSchema },
      // The booking spine validates the referenced Patient in-org; the
      // patient model/repo ride along rather than widening PatientsModule's
      // public surface.
      { name: PatientDocument.name, schema: PatientModelSchema },
    ]),
    AuditModule,
    ReportsCacheModule,
  ],
  controllers: [AppointmentsController],
  providers: [AppointmentRepository, PatientRepository, AppointmentsService],
})
export class AppointmentsModule {}
