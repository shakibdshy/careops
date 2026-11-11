import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AuditEntry } from '@careops/shared';
import type { OrgRequestContext } from '../data/org-scoped.repository.js';
import { AuditEntryDocument, type AuditEntryDoc } from './audit-entry.schema.js';

interface AuditCapture {
  context: OrgRequestContext;
  actor: { id: string; email: string };
  action: 'create' | 'update' | 'delete';
  entity: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Append-only audit capture (glossary: Audit Entry). Called explicitly by
 * domain services around each mutation so before/after diffs are reliable.
 * Entries are never updated or deleted — paths are immutable.
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditEntryDocument.name)
    private readonly auditModel: Model<AuditEntryDoc>,
  ) {}

  async record(capture: AuditCapture): Promise<void> {
    await this.auditModel.create({
      organizationId: capture.context.organizationId,
      actorId: capture.actor.id,
      actorEmail: capture.actor.email,
      action: capture.action,
      entity: capture.entity,
      entityId: capture.entityId,
      before: capture.before,
      after: capture.after,
      at: new Date(),
    });
  }

  toDto(doc: AuditEntryDoc): AuditEntry {
    return {
      id: String(doc._id),
      organizationId: doc.organizationId,
      actorId: doc.actorId,
      actorEmail: doc.actorEmail,
      action: doc.action,
      entity: doc.entity,
      entityId: doc.entityId,
      before: doc.before,
      after: doc.after,
      at: doc.at.toISOString(),
    };
  }
}
