import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AuditEntriesPage, AuditEntry } from '@careops/shared';
import type { OrgRequestContext } from '../data/org-scoped.repository.js';
import { AuditEntryDocument, type AuditEntryDoc } from './audit-entry.schema.js';

const DEFAULT_PAGE_SIZE = 20;

/**
 * Audit Entry reads (glossary: append-only — no update/delete exist here).
 * The collection carries an immutable schema, so a browse endpoint can never
 * expose a mutation path.
 */
export class AuditEntryReader {
  constructor(
    @InjectModel(AuditEntryDocument.name)
    private readonly auditModel: Model<AuditEntryDoc>,
  ) {}

  async listPage(
    context: OrgRequestContext,
    cursor?: string,
    limit: number = DEFAULT_PAGE_SIZE,
  ): Promise<AuditEntriesPage> {
    const filter: Record<string, unknown> = { organizationId: context.organizationId };
    if (cursor) {
      filter._id = { $lt: cursor };
    }
    const docs = await this.auditModel
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .exec();
    const hasMore = docs.length > limit;
    const items = hasMore ? docs.slice(0, limit) : docs;
    const last = items.at(-1);
    return {
      items: items.map((doc) => this.toDto(doc)),
      nextCursor: hasMore && last ? String(last._id) : undefined,
      hasMore,
    };
  }

  toDto(doc: AuditEntryDoc): AuditEntry {
    return {
      id: String(doc._id),
      organizationId: doc.organizationId,
      actorId: doc.actorId,
      actorEmail: doc.actorEmail,
      action: doc.action as AuditEntry['action'],
      entity: doc.entity,
      entityId: doc.entityId,
      before: doc.before,
      after: doc.after,
      at: doc.at.toISOString(),
    };
  }
}
