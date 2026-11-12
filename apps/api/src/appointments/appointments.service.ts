import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ConflictException } from '@nestjs/common';
import type { Connection, QueryFilter } from 'mongoose';
import type {
  Appointment,
  AppointmentsListQuery,
  CreateAppointmentDto,
  CursorPage,
} from '@careops/shared';
import { AuditService } from '../audit/audit.service.js';
import type { OrgRequestContext } from '../data/org-scoped.repository.js';
import type { FullOrganization } from '../auth/org-context.js';
import { PatientRepository } from '../patients/patient.repository.js';
import { AppointmentRepository } from './appointment.repository.js';
import type { AppointmentDoc } from './appointment.schema.js';

export interface AppointmentActor {
  id: string;
  email: string;
}

function toAppointmentDto(doc: AppointmentDoc): Appointment {
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

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly appointmentRepository: AppointmentRepository,
    private readonly patientRepository: PatientRepository,
    private readonly auditService: AuditService,
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
          throw new ConflictException({
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
}
