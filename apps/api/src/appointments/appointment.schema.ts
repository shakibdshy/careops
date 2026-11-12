import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { appointmentStatusSchema } from '@careops/shared';

@Schema({ collection: 'appointment' })
export class AppointmentDocument {
  @Prop({ required: true })
  organizationId!: string;

  @Prop({ required: true })
  patientId!: string;

  // The Provider: the Member assigned to deliver this Appointment (glossary).
  @Prop({ required: true })
  memberId!: string;

  @Prop({ required: true })
  start!: Date;

  // Derived from start + durationMinutes on every write; persisted so the
  // overlap check is a plain two-range query the compound index can serve
  // ($expr arithmetic would block index use).
  @Prop({ required: true })
  end!: Date;

  @Prop({ required: true, min: 15, max: 480 })
  durationMinutes!: number;

  @Prop({ required: true, enum: [...appointmentStatusSchema.options], default: 'SCHEDULED' })
  status!: string;

  @Prop({ maxLength: 2000 })
  notes?: string;

  @Prop({ required: true })
  createdAt!: Date;

  @Prop({ required: true })
  updatedAt!: Date;
}

export type AppointmentDoc = HydratedDocument<AppointmentDocument>;
export const AppointmentModelSchema = SchemaFactory.createForClass(AppointmentDocument);

// Query shapes (ADR-0006): every index leads with organizationId. The overlap
// check scans one member's appointments by start; the list is cursor-paginated
// by _id (ADR-0008, newest booking first).
AppointmentModelSchema.index({ organizationId: 1, memberId: 1, start: 1 });
AppointmentModelSchema.index({ organizationId: 1, _id: 1 });
// Reporting query shapes (ADR-0006): the org + start-range window serves the
// volume/status aggregations and today's range find (including its start sort);
// the utilization pipeline additionally excludes freed slots by status.
AppointmentModelSchema.index({ organizationId: 1, start: 1 });
AppointmentModelSchema.index({ organizationId: 1, status: 1, start: 1 });
