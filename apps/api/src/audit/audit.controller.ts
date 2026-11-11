import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuditEntriesPage } from '@careops/shared';
import { getOrgContext, OrgContextGuard, Roles } from '../auth/org-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ErrorResponseDto } from '../common/error-response.dto.js';
import { cursorPageQuerySchema, type CursorPageQuery } from '../common/cursor-query.js';
import { AuditEntriesPageDto } from './audit.dto.js';
import { AuditEntryReader } from './audit-entry.model.js';

/**
 * Audit Entry browsing (glossary: append-only, owner/admin visibility).
 * Newest first, cursor-paginated with the shared envelope (ADR-0008).
 */
@ApiTags('Audit Entries')
@ApiBearerAuth('session-cookie')
@ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Not authenticated' })
@ApiResponse({
  status: 403,
  type: ErrorResponseDto,
  description: 'Requires the admin or owner role',
})
@Controller('audit-entries')
@UseGuards(OrgContextGuard)
export class AuditController {
  constructor(private readonly auditReader: AuditEntryReader) {}

  @Get()
  @Roles('admin', 'owner')
  @ApiOperation({
    summary: 'Browse Audit Entries (owner/admin)',
    description:
      'Append-only who/what/when/before→after records for this organization, newest first. Every mutation to care data appears here.',
  })
  @ApiOkResponse({ type: AuditEntriesPageDto, description: 'Page of Audit Entries' })
  async list(
    @Req() request: Request,
    @Query(new ZodValidationPipe(cursorPageQuerySchema)) query: CursorPageQuery,
  ): Promise<AuditEntriesPage> {
    const context = getOrgContext(request);
    return this.auditReader.listPage(context, query.cursor, query.limit);
  }
}
