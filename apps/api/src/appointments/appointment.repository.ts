import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, QueryFilter, UpdateQuery } from 'mongoose';
import { Model } from 'mongoose';
import type { OrgRequestContext } from '../data/org-scoped.repository.js';
import { OrgScopedRepository } from '../data/org-scoped.repository.js';
import { AppointmentDocument, type AppointmentDoc } from './appointment.schema.js';
import { ProviderScheduleDocument } from './provider-schedule.schema.js';

/** Statuses that still hold the Provider's time (a freed slot can be rebooked). */
const SLOT_HOLDING_STATUSES = { $nin: ['CANCELLED', 'NO_SHOW'] };

export interface BookingWindow {
  memberId: string;
  start: Date;
  end: Date;
  /** A reschedule never conflicts with the appointment being moved. */
  excludeId?: string | undefined;
}

@Injectable()
export class AppointmentRepository extends OrgScopedRepository<AppointmentDoc> {
  constructor(
    @InjectModel(AppointmentDocument.name)
    appointmentModel: Model<AppointmentDoc>,
    @InjectModel(ProviderScheduleDocument.name)
    private readonly providerScheduleModel: Model<ProviderScheduleDocument>,
  ) {
    super(appointmentModel);
  }

  /**
   * The booking serializer (see ProviderScheduleDocument). A throwaway write
   * inside the transaction: concurrent bookings of the same Provider collide
   * here, one aborts transiently, the driver retries it against the winner's
   * snapshot — which is what turns "read-then-insert" into a real mutex.
   */
  async touchProviderSchedule(
    context: OrgRequestContext,
    memberId: string,
    session: ClientSession,
  ): Promise<void> {
    await this.providerScheduleModel
      .findOneAndUpdate(
        this.orgFilter(context, { memberId }),
        { $set: { updatedAt: new Date() } },
        { upsert: true, session },
      )
      .exec();
  }

  /**
   * The Conflict check (glossary): overlap of [start, end) against any
   * slot-holding appointment of the same Provider. Both ranges are plain
   * fields, so { organizationId, memberId, start } bounds the scan and the
   * end-comparison filters the small candidate set. Runs inside the caller's
   * transaction so the check and the insert share one snapshot.
   */
  async findConflicting(
    context: OrgRequestContext,
    window: BookingWindow,
    session: ClientSession,
  ): Promise<AppointmentDoc | null> {
    const filter = this.orgFilter(context, {
      memberId: window.memberId,
      status: SLOT_HOLDING_STATUSES,
      start: { $lt: window.end },
      end: { $gt: window.start },
    });
    if (window.excludeId) {
      // _id is ObjectId-typed in mongoose's strict query casting; the string
      // form is valid at runtime and cast through the raw filter record.
      (filter as Record<string, unknown>)['_id'] = { $ne: window.excludeId };
    }
    return this.model.findOne(filter).session(session).exec();
  }

  /** Snapshot read inside the caller's transaction (reschedule merges partial fields). */
  async findOneInTransaction(
    context: OrgRequestContext,
    filter: QueryFilter<AppointmentDoc>,
    session: ClientSession,
  ): Promise<AppointmentDoc | null> {
    return this.model.findOne(this.orgFilter(context, filter)).session(session).exec();
  }

  /**
   * Conditional update inside the caller's transaction; returnPreUpdate yields
   * the atomic before-state for the audit capture (same seam as Patients).
   */
  async updateInTransaction(
    context: OrgRequestContext,
    filter: QueryFilter<AppointmentDoc>,
    update: UpdateQuery<AppointmentDoc>,
    session: ClientSession,
    options: { returnPreUpdate?: boolean } = {},
  ): Promise<AppointmentDoc | null> {
    return this.model
      .findOneAndUpdate(this.orgFilter(context, filter), update, {
        new: !options.returnPreUpdate,
        session,
      })
      .exec();
  }

  /** Insert inside the caller's transaction; nothing persists if it aborts. */
  async createInTransaction(
    context: OrgRequestContext,
    data: Omit<AppointmentDocument, 'organizationId'>,
    session: ClientSession,
  ): Promise<AppointmentDoc> {
    return new this.model({ ...data, organizationId: context.organizationId }).save({ session });
  }
}
