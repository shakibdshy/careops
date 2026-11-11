import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { AuditEntriesPage } from '@careops/shared';
import { getOrgContext, OrgContextGuard, Roles } from '../auth/org-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuditEntryReader } from './audit-entry.model.js';
import { patientsListQuerySchema, type PatientsListQuery } from '../patients/patients.query.js';

/**
 * Audit Entry browsing (glossary: append-only, owner/admin visibility).
 * Newest first, cursor-paginated with the shared envelope (ADR-0008).
 */
@Controller('audit-entries')
@UseGuards(OrgContextGuard)
export class AuditController {
  constructor(private readonly auditReader: AuditEntryReader) {}

  @Get()
  @Roles('admin', 'owner')
  async list(
    @Req() request: Request,
    @Query(new ZodValidationPipe(patientsListQuerySchema)) query: PatientsListQuery,
  ): Promise<AuditEntriesPage> {
    const context = getOrgContext(request);
    return this.auditReader.listPage(context, query.cursor, query.limit);
  }
}
