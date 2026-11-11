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
import type { Request } from 'express';
import type { CursorPage, CreatePatientDto, Patient, UpdatePatientDto } from '@careops/shared';
import { createPatientSchema, updatePatientSchema } from '@careops/shared';
import { getOrgContext, getSession, OrgContextGuard, Roles } from '../auth/org-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { cursorPageQuerySchema, type CursorPageQuery } from '../common/cursor-query.js';
import { PatientsService } from './patients.service.js';

/**
 * Patients vertical slice (Week-1 template). Every route is org-scoped by
 * the guard; mutations are admin/owner; the audit trail records each one.
 * Validation pipes are parameter-scoped so they only transform the value
 * they name.
 */
@Controller('patients')
@UseGuards(OrgContextGuard)
export class PatientsController {
  constructor(private readonly patientsService: PatientsService) {}

  @Post()
  @Roles('admin', 'owner')
  async create(
    @Req() request: Request,
    @Body(new ZodValidationPipe(createPatientSchema)) body: CreatePatientDto,
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
  async list(
    @Req() request: Request,
    @Query(new ZodValidationPipe(cursorPageQuerySchema)) query: CursorPageQuery,
  ): Promise<CursorPage<Patient>> {
    const context = getOrgContext(request);
    return this.patientsService.listPage(context, query.cursor, query.limit);
  }

  @Get(':patientId')
  async findOne(@Req() request: Request, @Param('patientId') patientId: string): Promise<Patient> {
    const context = getOrgContext(request);
    return this.patientsService.findOne(context, patientId);
  }

  @Patch(':patientId')
  @Roles('admin', 'owner')
  async update(
    @Req() request: Request,
    @Param('patientId') patientId: string,
    @Body(new ZodValidationPipe(updatePatientSchema)) body: UpdatePatientDto,
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
