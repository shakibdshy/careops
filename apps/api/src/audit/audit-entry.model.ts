import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AuditEntriesPage } from '@careops/shared';
import type { OrgRequestContext } from '../data/org-scoped.repository.js';
import { OrgScopedRepository } from '../data/org-scoped.repository.js';
import { AuditEntryDocument, type AuditEntryDoc } from './audit-entry.schema.js';
import { auditEntryToDto } from './audit.service.js';

/**
 * Audit Entry reads (glossary: append-only — no update/delete exist here).
 * Org-scoped via the shared repository base (ADR-0006); newest-first cursor
 * scan with the shared envelope (ADR-0008).
 */
export class AuditEntryReader extends OrgScopedRepository<AuditEntryDoc> {
  constructor(
    @InjectModel(AuditEntryDocument.name)
    auditModel: Model<AuditEntryDoc>,
  ) {
    super(auditModel);
  }

  async listPage(
    context: OrgRequestContext,
    cursor?: string,
    limit: number = 20,
  ): Promise<AuditEntriesPage> {
    const page = await this.findPage(context, { limit, afterId: cursor, order: 'desc' });
    return {
      items: page.items.map(auditEntryToDto),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }
}
