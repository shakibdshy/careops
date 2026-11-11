import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'patient' })
export class PatientDocument {
  @Prop({ required: true })
  organizationId!: string;

  @Prop({ required: true, maxLength: 100 })
  firstName!: string;

  @Prop({ required: true, maxLength: 100 })
  lastName!: string;

  @Prop({ required: true })
  dateOfBirth!: Date;

  @Prop({ maxLength: 20 })
  phone?: string;

  @Prop({ maxLength: 2000 })
  notes?: string;

  @Prop({ required: true })
  createdAt!: Date;

  @Prop({ required: true })
  updatedAt!: Date;
}

export type PatientDoc = HydratedDocument<PatientDocument>;
export const PatientModelSchema = SchemaFactory.createForClass(PatientDocument);

// Query shapes (ADR-0006): every index leads with organizationId. The list is
// cursor-paginated by _id (ADR-0008), so { organizationId, _id } is the shape.
PatientModelSchema.index({ organizationId: 1, _id: 1 });
