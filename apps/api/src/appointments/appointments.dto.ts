import { createZodDto } from 'nestjs-zod';
import {
  appointmentsPageSchema,
  appointmentSchema,
  createAppointmentSchema,
} from '@careops/shared';

/** Swagger/DTO wrappers over the shared contract schemas (ADR-0002). */
export class CreateAppointmentDto extends createZodDto(createAppointmentSchema) {}
export class AppointmentDto extends createZodDto(appointmentSchema) {}
export class AppointmentsPageDto extends createZodDto(appointmentsPageSchema) {}
