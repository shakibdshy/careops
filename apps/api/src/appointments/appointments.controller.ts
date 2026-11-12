import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type {
  Appointment,
  AppointmentsListQuery as AppointmentsListQueryPayload,
  AppointmentsPage,
  CreateAppointmentDto as CreateAppointmentPayload,
} from '@careops/shared';
import { appointmentsListQuerySchema, createAppointmentSchema } from '@careops/shared';
import {
  getFullOrganization,
  getOrgContext,
  getSession,
  OrgContextGuard,
  Roles,
} from '../auth/org-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ErrorResponseDto } from '../common/error-response.dto.js';
import { AppointmentDto, AppointmentsPageDto, CreateAppointmentDto } from './appointments.dto.js';
import { AppointmentsService } from './appointments.service.js';

/**
 * Appointments vertical slice (Week-2). Every route is org-scoped by the
 * guard; mutations are admin/owner (MEMBER+ read); bookings are audited and
 * conflict-checked inside a transaction.
 */
@ApiTags('Appointments')
@ApiBearerAuth('session-cookie')
@ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Not authenticated' })
@ApiResponse({
  status: 403,
  type: ErrorResponseDto,
  description: 'Role does not permit the action',
})
@Controller('appointments')
@UseGuards(OrgContextGuard)
export class AppointmentsController {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  @Post()
  @Roles('admin', 'owner')
  @ApiOperation({
    summary: 'Book an appointment',
    description:
      'Books a Provider (Member) for one Patient at a UTC start + duration. The Conflict check and the insert share one transaction: an overlapping booking is a hard 409. Requires the admin or owner role.',
  })
  @ApiBody({ type: CreateAppointmentDto })
  @ApiResponse({ status: 201, type: AppointmentDto, description: 'Appointment booked (audited)' })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'Validation failed — field-level errors',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'Referenced Patient or Provider Member does not exist in this organization',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'Conflict — the Provider already holds an overlapping slot',
  })
  async create(
    @Req() request: Request,
    @Body(new ZodValidationPipe(createAppointmentSchema)) body: CreateAppointmentPayload,
  ): Promise<Appointment> {
    const context = getOrgContext(request);
    const fullOrg = getFullOrganization(request);
    const session = getSession(request);
    return this.appointmentsService.create(
      context,
      fullOrg.members,
      { id: session.user.id, email: session.user.email },
      body,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List appointments (cursor-paginated)',
    description:
      'Newest-first _id cursor scan scoped to the active organization, filterable by status, Provider, and start-time window. Pass nextCursor from the previous page as cursor to continue.',
  })
  @ApiResponse({
    status: 200,
    type: AppointmentsPageDto,
    description: 'Page of appointments with nextCursor and hasMore',
  })
  async list(
    @Req() request: Request,
    @Query(new ZodValidationPipe(appointmentsListQuerySchema)) query: AppointmentsListQueryPayload,
  ): Promise<AppointmentsPage> {
    const context = getOrgContext(request);
    return this.appointmentsService.listPage(context, query);
  }

  @Get(':appointmentId')
  @ApiOperation({ summary: 'Fetch one appointment' })
  @ApiResponse({ status: 200, type: AppointmentDto, description: 'The appointment' })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description:
      'Not found in this organization (cross-tenant access is indistinguishable from missing)',
  })
  async findOne(
    @Req() request: Request,
    @Param('appointmentId') appointmentId: string,
  ): Promise<Appointment> {
    const context = getOrgContext(request);
    return this.appointmentsService.findOne(context, appointmentId);
  }
}
