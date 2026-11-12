import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  reportWindowQuerySchema,
  type DailyVolume,
  type ProviderUtilizationReport,
  type ReportWindowQuery,
  type StatusBreakdown,
  type TodaySchedule,
} from '@careops/shared';
import { getOrgContext, OrgContextGuard } from '../auth/org-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ErrorResponseDto } from '../common/error-response.dto.js';
import {
  DailyVolumeDto,
  ProviderUtilizationReportDto,
  ReportWindowQueryDto,
  StatusBreakdownDto,
  TodayScheduleDto,
} from './reports.dto.js';
import { ReportsService } from './reports.service.js';

/**
 * Reporting reads (W2-T7). Every route is org-scoped by the guard and open to
 * MEMBER+ (no @Roles): reports are read-only operational views, not mutations.
 * The windowed reports take a bounded `days` query (default 30, 1..90) so a
 * malformed value is a 400 at the boundary, never an unbounded scan.
 */
@ApiTags('Reports')
@ApiBearerAuth('session-cookie')
@ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Not authenticated' })
@ApiResponse({
  status: 403,
  type: ErrorResponseDto,
  description: 'No active organization membership',
})
@Controller('reports')
@UseGuards(OrgContextGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('daily-volume')
  @ApiOperation({
    summary: 'Daily appointment volume',
    description:
      'Appointment counts bucketed by UTC calendar day over the trailing window (default 30 days), zero-filled so the trend has one point per day. Cached cache-aside under the organization generation counter.',
  })
  @ApiQuery({ type: ReportWindowQueryDto })
  @ApiResponse({ status: 200, type: DailyVolumeDto, description: 'One count per UTC day' })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'Validation failed — days out of range',
  })
  async dailyVolume(
    @Req() request: Request,
    @Query(new ZodValidationPipe(reportWindowQuerySchema)) query: ReportWindowQuery,
  ): Promise<DailyVolume> {
    return this.reportsService.dailyVolume(getOrgContext(request), query);
  }

  @Get('status-breakdown')
  @ApiOperation({
    summary: 'Status breakdown with operational rates',
    description:
      'Counts for all seven lifecycle states over the trailing window plus the cancellation and No-Show rates (each ÷ total, 0 for an empty window).',
  })
  @ApiQuery({ type: ReportWindowQueryDto })
  @ApiResponse({
    status: 200,
    type: StatusBreakdownDto,
    description: 'Per-status counts, total, cancellationRate, noShowRate',
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'Validation failed — days out of range',
  })
  async statusBreakdown(
    @Req() request: Request,
    @Query(new ZodValidationPipe(reportWindowQuerySchema)) query: ReportWindowQuery,
  ): Promise<StatusBreakdown> {
    return this.reportsService.statusBreakdown(getOrgContext(request), query);
  }

  @Get('provider-utilization')
  @ApiOperation({
    summary: 'Provider utilization',
    description:
      'Booked minutes per Provider (the assigned Member) over the trailing window, excluding cancelled and No-Show slots, against a documented 8h/day capacity. Provider names resolve server-side via $lookup. Cached cache-aside under the organization generation counter.',
  })
  @ApiQuery({ type: ReportWindowQueryDto })
  @ApiResponse({
    status: 200,
    type: ProviderUtilizationReportDto,
    description: 'Per-Provider booked minutes, counts, and utilization',
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'Validation failed — days out of range',
  })
  async providerUtilization(
    @Req() request: Request,
    @Query(new ZodValidationPipe(reportWindowQuerySchema)) query: ReportWindowQuery,
  ): Promise<ProviderUtilizationReport> {
    return this.reportsService.providerUtilization(getOrgContext(request), query);
  }

  @Get('today')
  @ApiOperation({
    summary: "Today's schedule",
    description:
      "Today's appointments (UTC day) as a plain indexed range query sorted by start — not an aggregation, and never cached, so the schedule is always current.",
  })
  @ApiResponse({
    status: 200,
    type: TodayScheduleDto,
    description: "The UTC date and today's appointments",
  })
  async today(@Req() request: Request): Promise<TodaySchedule> {
    return this.reportsService.today(getOrgContext(request));
  }
}
