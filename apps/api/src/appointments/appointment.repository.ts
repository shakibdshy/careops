import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession } from 'mongoose';
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
    return this.model
      .findOne(
        this.orgFilter(context, {
          memberId: window.memberId,
          status: SLOT_HOLDING_STATUSES,
          start: { $lt: window.end },
          end: { $gt: window.start },
        }),
      )
      .session(session)
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
