import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * One row per {organization, provider}. Its only job is to exist: every
 * booking transaction writes to it, so two concurrent bookings of the same
 * Provider collide on this document (write-write conflict) — the transaction
 * aborts one as a transient error, the driver retries it, and the retry sees
 * the winner's appointment and conflicts (409). Snapshot isolation alone
 * cannot do this: two inserts of different documents never conflict.
 */
@Schema({ collection: 'provider_schedule' })
export class ProviderScheduleDocument {
  @Prop({ required: true })
  organizationId!: string;

  @Prop({ required: true })
  memberId!: string;

  @Prop({ required: true })
  updatedAt!: Date;
}

export type ProviderScheduleDoc = HydratedDocument<ProviderScheduleDocument>;
export const ProviderScheduleModelSchema = SchemaFactory.createForClass(ProviderScheduleDocument);

ProviderScheduleModelSchema.index({ organizationId: 1, memberId: 1 }, { unique: true });
