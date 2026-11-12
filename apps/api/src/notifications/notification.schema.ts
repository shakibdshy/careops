import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { notificationStatusSchema, notificationTypeSchema } from '@careops/shared';

@Schema({ collection: 'notification' })
export class NotificationDocument {
  @Prop({ required: true })
  organizationId!: string;

  @Prop({ required: true, enum: [...notificationTypeSchema.options] })
  type!: string;

  // The referenced entity: appointmentId for appointment events, patientId for
  // patient.created. With type, it forms the storage-side dedup key.
  @Prop({ required: true })
  refId!: string;

  // Resolved at consume time from the Patient's Contact Email; absent when the
  // receipt is SKIPPED (no destination) or still PENDING.
  @Prop({ maxLength: 254 })
  recipient?: string;

  @Prop({ required: true, enum: [...notificationStatusSchema.options], default: 'PENDING' })
  status!: string;

  @Prop()
  providerMessageId?: string;

  @Prop({ required: true })
  createdAt!: Date;

  @Prop({ required: true })
  updatedAt!: Date;
}

export type NotificationDoc = HydratedDocument<NotificationDocument>;
export const NotificationModelSchema = SchemaFactory.createForClass(NotificationDocument);

// Storage-side dedup (ticket #29, ADR-0006): one receipt per {org, type, ref}.
// BullMQ dedups on jobId only while the job exists, and removeOnComplete prunes
// finished ids — so a re-enqueue after completion would deliver twice without
// this durable unique guard. The claim insert relies on it (duplicate → skip).
NotificationModelSchema.index({ organizationId: 1, type: 1, refId: 1 }, { unique: true });
