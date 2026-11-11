import { Body, Controller, Get, Post, Query, Req, UseGuards, UsePipes } from '@nestjs/common';
import type { Request } from 'express';
import type { CursorPage, CreatePatientDto, Patient } from '@careops/shared';
import { createPatientSchema } from '@careops/shared';
import { getOrgContext, getSession, OrgContextGuard, Roles } from '../auth/org-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
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
  async list(
    @Req() request: Request,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<CursorPage<Patient>> {
    const context = getOrgContext(request);
    const parsedLimit = limit !== undefined ? Math.min(Number(limit) || 20, 100) : undefined;
    return this.patientsService.listPage(context, cursor, parsedLimit);
  }

  @Get(':patientId')
  async findOne(@Req() request: Request, patientId: string): Promise<Patient> {
    const context = getOrgContext(request);
    return this.patientsService.findOne(context, patientId);
  }
}
