import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module.js';
import { AuditEntryDocument, AuditEntryModelSchema } from '../audit/audit-entry.schema.js';
import { PatientDocument, PatientModelSchema } from './patient.schema.js';
import { PatientRepository } from './patient.repository.js';
import { PatientsController } from './patients.controller.js';
import { PatientsService } from './patients.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PatientDocument.name, schema: PatientModelSchema },
      { name: AuditEntryDocument.name, schema: AuditEntryModelSchema },
    ]),
    AuditModule,
  ],
  controllers: [PatientsController],
  providers: [PatientRepository, PatientsService],
})
export class PatientsModule {}
