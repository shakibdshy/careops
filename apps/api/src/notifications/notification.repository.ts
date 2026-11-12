import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Notification, NotificationType } from '@careops/shared';
import type { OrgRequestContext } from '../data/org-scoped.repository.js';
import { OrgScopedRepository } from '../data/org-scoped.repository.js';
import { NotificationDocument, type NotificationDoc } from './notification.schema.js';

/** Mongo's duplicate-key code: the unique {org, type, refId} index rejected the insert. */
function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown }).code === 11000;
}

export function toNotificationDto(doc: NotificationDoc): Notification {
  return {
    id: String(doc._id),
    organizationId: doc.organizationId,
    type: doc.type as Notification['type'],
    refId: doc.refId,
    recipient: doc.recipient,
    status: doc.status as Notification['status'],
    providerMessageId: doc.providerMessageId,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * Storage-side dedup + receipt ledger (ticket #29). The unique index on
 * {organizationId, type, refId} is the durable idempotency guard that BullMQ's
 * pruned jobIds cannot provide: claim() inserts a PENDING receipt and returns
 * null on a duplicate, so a re-enqueued event never delivers twice.
 */
@Injectable()
export class NotificationRepository extends OrgScopedRepository<NotificationDoc> {
  constructor(
    @InjectModel(NotificationDocument.name)
    notificationModel: Model<NotificationDoc>,
  ) {
    super(notificationModel);
  }

  /** Insert a PENDING receipt; null means the dedup index already holds one. */
  async claim(
    context: OrgRequestContext,
    type: NotificationType,
    refId: string,
  ): Promise<NotificationDoc | null> {
    const now = new Date();
    try {
      return await this.create(context, {
        type,
        refId,
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
      } as unknown as Omit<NotificationDoc, '_id'>);
    } catch (error) {
      if (isDuplicateKey(error)) {
        return null;
      }
      throw error;
    }
  }

  async markSent(
    context: OrgRequestContext,
    id: string,
    recipient: string,
    providerMessageId: string,
  ): Promise<void> {
    await this.findOneAndUpdate(
      context,
      { _id: id },
      { status: 'SENT', recipient, providerMessageId, updatedAt: new Date() },
    );
  }

  async markSkipped(context: OrgRequestContext, id: string): Promise<void> {
    await this.findOneAndUpdate(context, { _id: id }, { status: 'SKIPPED', updatedAt: new Date() });
  }

  async markFailed(context: OrgRequestContext, id: string, recipient: string): Promise<void> {
    await this.findOneAndUpdate(
      context,
      { _id: id },
      { status: 'FAILED', recipient, updatedAt: new Date() },
    );
  }
}
