import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { OrgRequestContext } from '../data/org-scoped.repository.js';
import { OrgScopedRepository } from '../data/org-scoped.repository.js';
import { AppointmentDocument, type AppointmentDoc } from '../appointments/appointment.schema.js';

/** Statuses that still hold the Provider's time (same rule as the Conflict check). */
const SLOT_HOLDING_STATUSES = { $nin: ['CANCELLED', 'NO_SHOW'] };

export interface StatusCountRow {
  status: string;
  count: number;
}

export interface ProviderUtilizationRow {
  memberId: string;
  providerName: string;
  bookedMinutes: number;
  appointmentCount: number;
}

/**
 * Read-side aggregation queries for the reporting dashboard (W2-T7). Every
 * pipeline opens with the org-scoped `$match` (ADR-0006) so no stage can widen
 * the tenant boundary. `/today` is deliberately a plain indexed range find,
 * not an aggregation (spec).
 */
@Injectable()
export class ReportsRepository extends OrgScopedRepository<AppointmentDoc> {
  constructor(@InjectModel(AppointmentDocument.name) model: Model<AppointmentDoc>) {
    super(model);
  }

  /** Appointment counts bucketed by UTC calendar day over [start, end). */
  async dailyVolume(
    context: OrgRequestContext,
    start: Date,
    end: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.model
      .aggregate<{ _id: string; count: number }>([
        { $match: this.orgFilter(context, { start: { $gte: start, $lt: end } }) },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$start', timezone: 'UTC' } },
            count: { $sum: 1 },
          },
        },
      ])
      .exec();
    return new Map(rows.map((row) => [row._id, row.count]));
  }

  /** Counts per status over [start, end); the service zero-fills all seven states. */
  async statusBreakdown(
    context: OrgRequestContext,
    start: Date,
    end: Date,
  ): Promise<StatusCountRow[]> {
    const rows = await this.model
      .aggregate<{ _id: string; count: number }>([
        { $match: this.orgFilter(context, { start: { $gte: start, $lt: end } }) },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .exec();
    return rows.map((row) => ({ status: row._id, count: row.count }));
  }

  /**
   * Booked minutes per Provider over [start, end), excluding freed slots.
   * Provider names resolve through two `$lookup`s: appointment.memberId is the
   * string form of BetterAuth's ObjectId member._id, so the first join casts it
   * back with `$toObjectId`; member.userId then joins the user collection for
   * the display name. Both joins are index-served on `_id`.
   */
  async providerUtilization(
    context: OrgRequestContext,
    start: Date,
    end: Date,
  ): Promise<ProviderUtilizationRow[]> {
    return this.model
      .aggregate<ProviderUtilizationRow>([
        {
          $match: this.orgFilter(context, {
            status: SLOT_HOLDING_STATUSES,
            start: { $gte: start, $lt: end },
          }),
        },
        {
          $group: {
            _id: '$memberId',
            bookedMinutes: { $sum: '$durationMinutes' },
            appointmentCount: { $sum: 1 },
          },
        },
        {
          $lookup: {
            from: 'member',
            let: { mid: '$_id' },
            pipeline: [
              { $match: { $expr: { $eq: ['$_id', { $toObjectId: '$$mid' }] } } },
              { $project: { _id: 0, userId: 1 } },
            ],
            as: 'memberDoc',
          },
        },
        { $unwind: '$memberDoc' },
        {
          $lookup: {
            from: 'user',
            let: { uid: '$memberDoc.userId' },
            pipeline: [
              { $match: { $expr: { $eq: ['$_id', '$$uid'] } } },
              { $project: { _id: 0, name: 1 } },
            ],
            as: 'userDoc',
          },
        },
        { $unwind: '$userDoc' },
        {
          $project: {
            _id: 0,
            memberId: '$_id',
            providerName: '$userDoc.name',
            bookedMinutes: 1,
            appointmentCount: 1,
          },
        },
        { $sort: { bookedMinutes: -1 } },
      ])
      .exec();
  }

  /** Today's schedule: a plain indexed range query sorted by start (not an aggregation). */
  async today(context: OrgRequestContext, start: Date, end: Date): Promise<AppointmentDoc[]> {
    return this.model
      .find(this.orgFilter(context, { start: { $gte: start, $lt: end } }))
      .sort({ start: 1 })
      .exec();
  }
}
