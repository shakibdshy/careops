import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import type { Request } from 'express';
import type { CursorPage, CreatePatientDto, Patient } from '@careops/shared';
import { createPatientSchema } from '@careops/shared';
import { getOrgContext, getSession, OrgContextGuard, Roles } from '../auth/org-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { patientsListQuerySchema, type PatientsListQuery } from './patients.query.js';
import { PatientsService } from './patients.service.js';

/**
 * Patients vertical slice (Week-1 template). Every route is org-scoped by
 * the guard; mutations are admin/owner; the audit trail records each one.
 */
@Controller('patients')
@UseGuards(OrgContextGuard)
export class PatientsController {
  constructor(private readonly patientsService: PatientsService) {}

  @Post()
  @Roles('admin', 'owner')
  @UsePipes(new ZodValidationPipe(createPatientSchema))
  async create(@Req() request: Request, @Body() body: CreatePatientDto): Promise<Patient> {
    const context = getOrgContext(request);
    const session = getSession(request);
    return this.patientsService.create(
      context,
      { id: session.user.id, email: session.user.email },
      body,
    );
  }

  @Get()
  @UsePipes(new ZodValidationPipe(patientsListQuerySchema))
  async list(
    @Req() request: Request,
    @Query() query: PatientsListQuery,
  ): Promise<CursorPage<Patient>> {
    const context = getOrgContext(request);
    return this.patientsService.listPage(context, query.cursor, query.limit);
  }

  @Get(':patientId')
  async findOne(@Req() request: Request, @Param('patientId') patientId: string): Promise<Patient> {
    const context = getOrgContext(request);
    return this.patientsService.findOne(context, patientId);
  }
}
