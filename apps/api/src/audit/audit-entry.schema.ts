import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'audit_entry' })
export class AuditEntryDocument {
  @Prop({ required: true, immutable: true })
  organizationId!: string;

  @Prop({ required: true, immutable: true })
  actorId!: string;

  @Prop({ required: true, immutable: true })
  actorEmail!: string;

  @Prop({ required: true, immutable: true })
  action!: string;

  @Prop({ required: true, immutable: true })
  entity!: string;

  @Prop({ required: true, immutable: true })
  entityId!: string;

  @Prop({ type: Object, default: null, immutable: true })
  before!: Record<string, unknown> | null;

  @Prop({ type: Object, default: null, immutable: true })
  after!: Record<string, unknown> | null;

  @Prop({ required: true, immutable: true })
  at!: Date;
}

export type AuditEntryDoc = HydratedDocument<AuditEntryDocument>;
export const AuditEntryModelSchema = SchemaFactory.createForClass(AuditEntryDocument);

// Audit browsing (query shape, ADR-0006): newest-first _id cursor scan per
// ADR-0008 — { organizationId, _id desc } is the serving index.
AuditEntryModelSchema.index({ organizationId: 1, _id: -1 });
