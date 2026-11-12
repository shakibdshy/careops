import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type {
  Appointment,
  AppointmentTransitionDto as AppointmentTransitionPayload,
  AppointmentsListQuery as AppointmentsListQueryPayload,
  AppointmentsPage,
  CreateAppointmentDto as CreateAppointmentPayload,
  RescheduleAppointmentDto as RescheduleAppointmentPayload,
} from '@careops/shared';
import {
  appointmentTransitionSchema,
  appointmentsListQuerySchema,
  createAppointmentSchema,
  rescheduleAppointmentSchema,
} from '@careops/shared';
import {
  getFullOrganization,
  getOrgContext,
  getSession,
  OrgContextGuard,
  Roles,
} from '../auth/org-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ErrorResponseDto } from '../common/error-response.dto.js';
import {
  AppointmentDto,
  AppointmentsPageDto,
  AppointmentTransitionDto,
  CreateAppointmentDto,
  RescheduleAppointmentDto,
} from './appointments.dto.js';
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

  @Post(':appointmentId/status')
  @HttpCode(HttpStatus.OK)
  @Roles('admin', 'owner')
  @ApiOperation({
    summary: 'Transition an appointment',
    description:
      'Moves the appointment one step along the clinic lifecycle (audited before→after). An illegal jump is a 409 naming the allowed target statuses; terminal appointments (COMPLETED, CANCELLED, NO_SHOW) reject every transition. Requires the admin or owner role.',
  })
  @ApiBody({ type: AppointmentTransitionDto })
  @ApiResponse({ status: 200, type: AppointmentDto, description: 'Transition applied (audited)' })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'Validation failed — unknown target status',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'Not found in this organization',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'Illegal transition — the allowed targets are named in errors[]',
  })
  async transition(
    @Req() request: Request,
    @Param('appointmentId') appointmentId: string,
    @Body(new ZodValidationPipe(appointmentTransitionSchema)) body: AppointmentTransitionPayload,
  ): Promise<Appointment> {
    const context = getOrgContext(request);
    const session = getSession(request);
    return this.appointmentsService.transition(
      context,
      { id: session.user.id, email: session.user.email },
      appointmentId,
      body.status,
    );
  }

  @Patch(':appointmentId')
  @Roles('admin', 'owner')
  @ApiOperation({
    summary: 'Reschedule an appointment',
    description:
      'Changes the start, duration, and/or Provider of a SCHEDULED or CONFIRMED appointment (audited before→after), re-running the Conflict check inside the booking transaction. Later lifecycle states are a 409; an overlapping slot is a hard 409. Requires the admin or owner role.',
  })
  @ApiBody({ type: RescheduleAppointmentDto })
  @ApiResponse({ status: 200, type: AppointmentDto, description: 'Rescheduled (audited)' })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'Validation failed — field-level errors',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'Appointment or referenced Provider Member does not exist in this organization',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'Not reschedulable in the current state, or the new slot conflicts',
  })
  async reschedule(
    @Req() request: Request,
    @Param('appointmentId') appointmentId: string,
    @Body(new ZodValidationPipe(rescheduleAppointmentSchema)) body: RescheduleAppointmentPayload,
  ): Promise<Appointment> {
    const context = getOrgContext(request);
    const fullOrg = getFullOrganization(request);
    const session = getSession(request);
    return this.appointmentsService.reschedule(
      context,
      fullOrg.members,
      { id: session.user.id, email: session.user.email },
      appointmentId,
      body,
    );
  }
}
