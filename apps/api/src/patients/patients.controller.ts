import {
  Body,
  Controller,
  Delete,
  Get,
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
  CursorPage,
  CreatePatientDto as CreatePatientPayload,
  Patient,
  UpdatePatientDto as UpdatePatientPayload,
} from '@careops/shared';
import { createPatientSchema, updatePatientSchema } from '@careops/shared';
import { getOrgContext, getSession, OrgContextGuard, Roles } from '../auth/org-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ErrorResponseDto } from '../common/error-response.dto.js';
import { cursorPageQuerySchema, type CursorPageQuery } from '../common/cursor-query.js';
import { CreatePatientDto, PatientDto, PatientsPageDto, UpdatePatientDto } from './patients.dto.js';
import { PatientsService } from './patients.service.js';

/**
 * Patients vertical slice (Week-1 template). Every route is org-scoped by
 * the guard; mutations are admin/owner; the audit trail records each one.
 * Validation pipes are parameter-scoped so they only transform the value
 * they name.
 */
@ApiTags('Patients')
@ApiBearerAuth('session-cookie')
@ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Not authenticated' })
@ApiResponse({
  status: 403,
  type: ErrorResponseDto,
  description: 'Role does not permit the action',
})
@Controller('patients')
@UseGuards(OrgContextGuard)
export class PatientsController {
  constructor(private readonly patientsService: PatientsService) {}

  @Post()
  @Roles('admin', 'owner')
  @ApiOperation({
    summary: 'Create a patient',
    description:
      'Creates an org-scoped Patient record and writes an Audit Entry (null→created). Requires the admin or owner role.',
  })
  @ApiBody({ type: CreatePatientDto })
  @ApiResponse({ status: 201, type: PatientDto, description: 'Patient created (audited)' })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'Validation failed — field-level errors',
  })
  async create(
    @Req() request: Request,
    @Body(new ZodValidationPipe(createPatientSchema)) body: CreatePatientPayload,
  ): Promise<Patient> {
    const context = getOrgContext(request);
    const session = getSession(request);
    return this.patientsService.create(
      context,
      { id: session.user.id, email: session.user.email },
      body,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List patients (cursor-paginated)',
    description:
      'Newest-last _id cursor scan scoped to the active organization. Pass nextCursor from the previous page as cursor to continue.',
  })
  @ApiResponse({
    status: 200,
    type: PatientsPageDto,
    description: 'Page of patients with nextCursor and hasMore',
  })
  async list(
    @Req() request: Request,
    @Query(new ZodValidationPipe(cursorPageQuerySchema)) query: CursorPageQuery,
  ): Promise<CursorPage<Patient>> {
    const context = getOrgContext(request);
    return this.patientsService.listPage(context, query.cursor, query.limit);
  }

  @Get(':patientId')
  @ApiOperation({ summary: 'Fetch one patient' })
  @ApiResponse({ status: 200, type: PatientDto, description: 'The patient' })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description:
      'Not found in this organization (cross-tenant access is indistinguishable from missing)',
  })
  async findOne(@Req() request: Request, @Param('patientId') patientId: string): Promise<Patient> {
    const context = getOrgContext(request);
    return this.patientsService.findOne(context, patientId);
  }

  @Patch(':patientId')
  @Roles('admin', 'owner')
  @ApiOperation({
    summary: 'Update a patient (partial)',
    description:
      'Applies the given fields and writes an Audit Entry with the atomic before→after diff. Requires the admin or owner role.',
  })
  @ApiBody({ type: UpdatePatientDto })
  @ApiResponse({ status: 200, type: PatientDto, description: 'Updated patient (audited)' })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'Validation failed — field-level errors',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'Not found in this organization',
  })
  async update(
    @Req() request: Request,
    @Param('patientId') patientId: string,
    @Body(new ZodValidationPipe(updatePatientSchema)) body: UpdatePatientPayload,
  ): Promise<Patient> {
    const context = getOrgContext(request);
    const session = getSession(request);
    return this.patientsService.update(
      context,
      { id: session.user.id, email: session.user.email },
      patientId,
      body,
    );
  }

  @Delete(':patientId')
  @Roles('admin', 'owner')
  @ApiOperation({
    summary: 'Delete a patient (hard)',
    description:
      'Hard-deletes the record; the Audit Entry retains the complete before-state as the recovery record. Requires the admin or owner role.',
  })
  @ApiResponse({ status: 200, description: 'Deleted (audited)' })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'Not found in this organization',
  })
  async remove(@Req() request: Request, @Param('patientId') patientId: string): Promise<void> {
    const context = getOrgContext(request);
    const session = getSession(request);
    await this.patientsService.remove(
      context,
      { id: session.user.id, email: session.user.email },
      patientId,
    );
  }
}
