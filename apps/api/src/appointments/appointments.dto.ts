import { createZodDto } from 'nestjs-zod';
import {
  appointmentSchema,
  appointmentTransitionSchema,
  appointmentsPageSchema,
  createAppointmentSchema,
  rescheduleAppointmentSchema,
} from '@careops/shared';

/** Swagger/DTO wrappers over the shared contract schemas (ADR-0002). */
export class CreateAppointmentDto extends createZodDto(createAppointmentSchema) {}
export class AppointmentDto extends createZodDto(appointmentSchema) {}
export class AppointmentsPageDto extends createZodDto(appointmentsPageSchema) {}
export class AppointmentTransitionDto extends createZodDto(appointmentTransitionSchema) {}
export class RescheduleAppointmentDto extends createZodDto(rescheduleAppointmentSchema) {}
