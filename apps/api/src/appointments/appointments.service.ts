import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ConflictException } from '@nestjs/common';
import type { Connection, QueryFilter } from 'mongoose';
import { Queue } from 'bullmq';
import type {
  Appointment,
  AppointmentStatus,
  AppointmentsListQuery,
  CreateAppointmentDto,
  CursorPage,
  RescheduleAppointmentDto,
} from '@careops/shared';
import { AuditService } from '../audit/audit.service.js';
import type { OrgRequestContext } from '../data/org-scoped.repository.js';
import type { FullOrganization } from '../auth/org-context.js';
import { PatientRepository } from '../patients/patient.repository.js';
import { ReportsCache } from '../reports/reports.cache.js';
import {
  APPOINTMENT_CREATED_JOB,
  APPOINTMENT_REMINDER_JOB,
  NOTIFICATIONS_QUEUE,
  REMINDER_LEAD_MS,
  appointmentCreatedJobId,
  appointmentReminderJobId,
} from '../notifications/notifications.tokens.js';
import type {
  AppointmentReminderJob,
  NotificationJob,
} from '../notifications/notifications.tokens.js';
import { AppointmentRepository } from './appointment.repository.js';
import type { AppointmentDoc } from './appointment.schema.js';
import { ALLOWED_TRANSITIONS, isAllowedTransition, RESCHEDULABLE_STATUSES } from '@careops/shared';

export interface AppointmentActor {
  id: string;
  email: string;
}

export function toAppointmentDto(doc: AppointmentDoc): Appointment {
  return {
    id: String(doc._id),
    organizationId: doc.organizationId,
    patientId: doc.patientId,
    memberId: doc.memberId,
    start: doc.start.toISOString(),
    durationMinutes: doc.durationMinutes,
    status: doc.status as Appointment['status'],
    notes: doc.notes,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function slotConflict(conflict: AppointmentDoc): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: 'Provider already booked for an overlapping appointment',
    errors: [
      {
        field: 'start',
        message: `Conflicts with an appointment at ${conflict.start.toISOString()}`,
      },
    ],
  });
}

function transitionConflict(from: AppointmentStatus, to: AppointmentStatus): ConflictException {
  const allowed = ALLOWED_TRANSITIONS[from];
  return new ConflictException({
    statusCode: 409,
    message: `Cannot transition an appointment from ${from} to ${to}`,
    errors: [
      {
        field: 'status',
        message: `Allowed transitions from ${from}: ${
          allowed.length > 0 ? allowed.join(', ') : 'none (terminal status)'
        }`,
      },
    ],
  });
}

function notReschedulable(status: AppointmentStatus): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: `Cannot reschedule an appointment in status ${status}`,
    errors: [
      {
        field: 'status',
        message: 'Only SCHEDULED or CONFIRMED appointments can be rescheduled',
      },
    ],
  });
}

@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    private readonly appointmentRepository: AppointmentRepository,
    private readonly patientRepository: PatientRepository,
    private readonly auditService: AuditService,
    private readonly reportsCache: ReportsCache,
    @Inject(NOTIFICATIONS_QUEUE)
    private readonly notificationsQueue: Queue<NotificationJob>,
    @InjectConnection()
    private readonly connection: Connection,
  ) {}

  /**
   * Booking. The referenced Patient and Provider Member must exist in this
   * organization (cross-tenant references are 404, never 403). The Conflict
   * check (glossary) and the insert share one transaction: two concurrent
   * bookings of the same slot can never both win — the loser aborts and the
   * driver's transient-retry re-runs it against the winner's snapshot, which
   * now conflicts (409).
   */
  async create(
    context: OrgRequestContext,
    orgMembers: FullOrganization['members'],
    actor: AppointmentActor,
    dto: CreateAppointmentDto,
  ): Promise<Appointment> {
    const provider = orgMembers.find((member) => member.id === dto.memberId);
    if (!provider) {
      throw new NotFoundException('Provider member not found in organization');
    }
    const patient = await this.patientRepository.findOne(context, { _id: dto.patientId });
    if (!patient) {
      throw new NotFoundException('Patient not found');
    }

    // Contract speaks ISO strings (zod-v4 JSON-schema lesson); mongoose
    // persists Dates. `end` is derived and persisted next to `start` so the
    // overlap check stays index-servable.
    const start = new Date(dto.start);
    const end = new Date(start.getTime() + dto.durationMinutes * 60_000);

    const session = this.connection.getClient().startSession();
    let created: AppointmentDoc | undefined;
    try {
      created = await session.withTransaction(async (txSession): Promise<AppointmentDoc> => {
        // Serialize concurrent bookings of the same Provider before reading:
        // this write is what makes conflicting transactions collide (see
        // ProviderScheduleDocument).
        await this.appointmentRepository.touchProviderSchedule(context, dto.memberId, txSession);
        const conflict = await this.appointmentRepository.findConflicting(
          context,
          { memberId: dto.memberId, start, end },
          txSession,
        );
        if (conflict) {
          throw slotConflict(conflict);
        }
        return this.appointmentRepository.createInTransaction(
          context,
          {
            patientId: dto.patientId,
            memberId: dto.memberId,
            start,
            end,
            durationMinutes: dto.durationMinutes,
            status: 'SCHEDULED',
            ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          txSession,
        );
      });
    } finally {
      await session.endSession();
    }
    if (!created) {
      // The transaction aborted without an application error (transient
      // retry exhaustion) — the slot was not claimed.
      throw new ConflictException({
        statusCode: 409,
        message: 'Booking could not be completed, please retry',
        errors: [],
      });
    }

    await this.auditService.record({
      context,
      actor,
      action: 'create',
      entity: 'appointment',
      entityId: String(created._id),
      before: null,
      after: toAppointmentDto(created),
    });
    await this.reportsCache.bumpGeneration(context.organizationId);
    await this.enqueueBookingNotifications(context, created);
    return toAppointmentDto(created);
  }

  /**
   * Cross-tenant access is impossible by construction: the repository scope
   * comes from the verified session and an appointment outside the
   * organization is indistinguishable from a missing one (404, never 403).
   */
  async findOne(context: OrgRequestContext, appointmentId: string): Promise<Appointment> {
    const doc = await this.appointmentRepository.findOne(context, { _id: appointmentId });
    if (!doc) {
      throw new NotFoundException('Appointment not found');
    }
    return toAppointmentDto(doc);
  }

  async listPage(
    context: OrgRequestContext,
    query: AppointmentsListQuery,
  ): Promise<CursorPage<Appointment>> {
    const filter: QueryFilter<AppointmentDoc> = {};
    if (query.status) {
      filter.status = query.status;
    }
    if (query.memberId) {
      filter.memberId = query.memberId;
    }
    if (query.from || query.to) {
      filter.start = {
        ...(query.from ? { $gte: new Date(query.from) } : {}),
        ...(query.to ? { $lte: new Date(query.to) } : {}),
      };
    }
    const page = await this.appointmentRepository.findPage(context, {
      filter,
      // The shared query schema defaults the limit; the service trusts it.
      limit: query.limit,
      afterId: query.cursor,
      order: 'desc',
    });
    return {
      items: page.items.map(toAppointmentDto),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  /**
   * One lifecycle move. The write is a compare-and-swap on the observed
   * status, so two concurrent transitions can never both apply: the loser
   * matches nothing and gets a 409 naming the current allowed targets.
   */
  async transition(
    context: OrgRequestContext,
    actor: AppointmentActor,
    appointmentId: string,
    target: AppointmentStatus,
  ): Promise<Appointment> {
    const doc = await this.appointmentRepository.findOne(context, { _id: appointmentId });
    if (!doc) {
      throw new NotFoundException('Appointment not found');
    }
    const from = doc.status as AppointmentStatus;
    if (!isAllowedTransition(from, target)) {
      throw transitionConflict(from, target);
    }
    const before = await this.appointmentRepository.findOneAndUpdate(
      context,
      { _id: appointmentId, status: from },
      { status: target, updatedAt: new Date() },
      { returnPreUpdate: true },
    );
    if (!before) {
      const current = await this.appointmentRepository.findOne(context, { _id: appointmentId });
      if (!current) {
        throw new NotFoundException('Appointment not found');
      }
      throw transitionConflict(current.status as AppointmentStatus, target);
    }
    const after = await this.appointmentRepository.findOne(context, { _id: appointmentId });
    if (!after) {
      throw new NotFoundException('Appointment not found');
    }
    await this.auditService.record({
      context,
      actor,
      action: 'update',
      entity: 'appointment',
      entityId: appointmentId,
      before: toAppointmentDto(before),
      after: toAppointmentDto(after),
    });
    await this.reportsCache.bumpGeneration(context.organizationId);
    // A cancelled Appointment must not fire its pending reminder (ticket #29).
    if (target === 'CANCELLED') {
      await this.cancelReminder(appointmentId);
    }
    return toAppointmentDto(after);
  }

  /**
   * Reschedule (glossary): only SCHEDULED or CONFIRMED appointments may move.
   * The state gate, the Conflict re-check, and the update share one transaction
   * with the booking serializer — the same engine as create, with the moved
   * appointment excluded from its own overlap scan.
   */
  async reschedule(
    context: OrgRequestContext,
    orgMembers: FullOrganization['members'],
    actor: AppointmentActor,
    appointmentId: string,
    dto: RescheduleAppointmentDto,
  ): Promise<Appointment> {
    if (dto.memberId !== undefined) {
      const provider = orgMembers.find((member) => member.id === dto.memberId);
      if (!provider) {
        throw new NotFoundException('Provider member not found in organization');
      }
    }

    const session = this.connection.getClient().startSession();
    let before: AppointmentDoc | undefined;
    try {
      before = await session.withTransaction(async (txSession): Promise<AppointmentDoc> => {
        const current = await this.appointmentRepository.findOneInTransaction(
          context,
          { _id: appointmentId },
          txSession,
        );
        if (!current) {
          throw new NotFoundException('Appointment not found');
        }
        const status = current.status as AppointmentStatus;
        if (!RESCHEDULABLE_STATUSES.includes(status)) {
          throw notReschedulable(status);
        }
        const memberId = dto.memberId ?? current.memberId;
        const start = dto.start !== undefined ? new Date(dto.start) : current.start;
        const durationMinutes = dto.durationMinutes ?? current.durationMinutes;
        const end = new Date(start.getTime() + durationMinutes * 60_000);

        await this.appointmentRepository.touchProviderSchedule(context, memberId, txSession);
        const conflict = await this.appointmentRepository.findConflicting(
          context,
          { memberId, start, end, excludeId: appointmentId },
          txSession,
        );
        if (conflict) {
          throw slotConflict(conflict);
        }
        const pre = await this.appointmentRepository.updateInTransaction(
          context,
          { _id: appointmentId, status: { $in: [...RESCHEDULABLE_STATUSES] } },
          { memberId, start, end, durationMinutes, updatedAt: new Date() },
          txSession,
          { returnPreUpdate: true },
        );
        if (!pre) {
          // A concurrent transition moved the appointment out of a
          // reschedulable state between the snapshot read and the write.
          throw new ConflictException({
            statusCode: 409,
            message: 'Appointment changed concurrently, please retry',
            errors: [],
          });
        }
        return pre;
      });
    } finally {
      await session.endSession();
    }
    if (!before) {
      // Transient retry exhaustion — nothing was moved.
      throw new ConflictException({
        statusCode: 409,
        message: 'Reschedule could not be completed, please retry',
        errors: [],
      });
    }
    const after = await this.appointmentRepository.findOne(context, { _id: appointmentId });
    if (!after) {
      throw new NotFoundException('Appointment not found');
    }
    await this.auditService.record({
      context,
      actor,
      action: 'update',
      entity: 'appointment',
      entityId: appointmentId,
      before: toAppointmentDto(before),
      after: toAppointmentDto(after),
    });
    await this.reportsCache.bumpGeneration(context.organizationId);
    // Re-arm the reminder for the moved start: drop the old delayed job, then
    // schedule a new one only if start − 24h is still ahead (ticket #29). A move
    // to within 24h leaves no reminder — it is already past the reminder time.
    await this.cancelReminder(appointmentId);
    await this.scheduleReminder({
      organizationId: context.organizationId,
      appointmentId,
      patientId: after.patientId,
      start: after.start.toISOString(),
    });
    return toAppointmentDto(after);
  }

  /** Confirmation (immediate) + reminder (delayed to start − 24h) on booking. */
  private async enqueueBookingNotifications(
    context: OrgRequestContext,
    appointment: AppointmentDoc,
  ): Promise<void> {
    const data = {
      organizationId: context.organizationId,
      appointmentId: String(appointment._id),
      patientId: appointment.patientId,
      start: appointment.start.toISOString(),
    };
    await this.notificationsQueue.add(APPOINTMENT_CREATED_JOB, data, {
      jobId: appointmentCreatedJobId(data.appointmentId),
    });
    await this.scheduleReminder(data);
  }

  /** Schedule the reminder only when start − 24h is still in the future. */
  private async scheduleReminder(data: AppointmentReminderJob): Promise<void> {
    const delay = new Date(data.start).getTime() - REMINDER_LEAD_MS - Date.now();
    if (delay > 0) {
      await this.notificationsQueue.add(APPOINTMENT_REMINDER_JOB, data, {
        jobId: appointmentReminderJobId(data.appointmentId),
        delay,
      });
    }
  }

  /** Best-effort removal of a pending reminder (it may already have fired). */
  private async cancelReminder(appointmentId: string): Promise<void> {
    try {
      await this.notificationsQueue.remove(appointmentReminderJobId(appointmentId));
    } catch (error) {
      this.logger.warn(`Could not cancel reminder for ${appointmentId}: ${String(error)}`);
    }
  }
}
