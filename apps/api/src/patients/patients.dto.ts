import { createZodDto } from 'nestjs-zod';
import {
  createPatientSchema,
  patientSchema,
  patientsPageSchema,
  updatePatientSchema,
} from '@careops/shared';

/** Swagger/DTO wrapper over the shared contract schema (ADR-0002). */
export class CreatePatientDto extends createZodDto(createPatientSchema) {}
export class UpdatePatientDto extends createZodDto(updatePatientSchema) {}
export class PatientDto extends createZodDto(patientSchema) {}
export class PatientsPageDto extends createZodDto(patientsPageSchema) {}
