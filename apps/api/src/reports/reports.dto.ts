import { createZodDto } from 'nestjs-zod';
import {
  dailyVolumeSchema,
  providerUtilizationReportSchema,
  reportWindowQuerySchema,
  statusBreakdownSchema,
  todayScheduleSchema,
} from '@careops/shared';

/** Swagger/DTO wrappers over the shared report contract (ADR-0002). */
export class ReportWindowQueryDto extends createZodDto(reportWindowQuerySchema) {}
export class DailyVolumeDto extends createZodDto(dailyVolumeSchema) {}
export class StatusBreakdownDto extends createZodDto(statusBreakdownSchema) {}
export class ProviderUtilizationReportDto extends createZodDto(providerUtilizationReportSchema) {}
export class TodayScheduleDto extends createZodDto(todayScheduleSchema) {}
