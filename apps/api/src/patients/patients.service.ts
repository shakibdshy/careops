import { Injectable, NotFoundException } from '@nestjs/common';
import type { CursorPage, CreatePatientDto, Patient } from '@careops/shared';
import { AuditService } from '../audit/audit.service.js';
import type { OrgRequestContext } from '../data/org-scoped.repository.js';
import { PatientRepository } from './patient.repository.js';
import type { PatientDoc } from './patient.schema.js';

export interface PatientActor {
  id: string;
  email: string;
}

const DEFAULT_PAGE_SIZE = 20;

function toPatientDto(doc: PatientDoc): Patient {
  return {
    id: String(doc._id),
    organizationId: doc.organizationId,
    firstName: doc.firstName,
    lastName: doc.lastName,
    dateOfBirth: doc.dateOfBirth.toISOString(),
    phone: doc.phone,
    notes: doc.notes,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

@Injectable()
export class PatientsService {
  constructor(
    private readonly patientRepository: PatientRepository,
    private readonly auditService: AuditService,
  ) {}

  async create(
    context: OrgRequestContext,
    actor: PatientActor,
    dto: CreatePatientDto,
  ): Promise<Patient> {
    const insert = {
      ...dto,
      dateOfBirth: dto.dateOfBirth,
      createdAt: new Date(),
      updatedAt: new Date(),
      // The repository insert payload is the persisted shape; extra document
      // plumbing (set/save/schema handles on the hydrated type) is not part
      // of it.
    };
    const doc = await this.patientRepository.create(
      context,
      insert as unknown as Omit<PatientDoc, '_id'>,
    );
    await this.auditService.record({
      context,
      actor,
      action: 'create',
      entity: 'patient',
      entityId: String(doc._id),
      before: null,
      after: toPatientDto(doc),
    });
    return toPatientDto(doc);
  }

  /**
   * Cross-tenant access is impossible by construction: the repository scope
   * comes from the verified session and a patient outside the organization
   * is indistinguishable from a missing one (404, never 403).
   */
  async findOne(context: OrgRequestContext, patientId: string): Promise<Patient> {
    const doc = await this.patientRepository.findOne(context, { _id: patientId });
    if (!doc) {
      throw new NotFoundException('Patient not found');
    }
    return toPatientDto(doc);
  }

  async listPage(
    context: OrgRequestContext,
    cursor?: string,
    limit: number = DEFAULT_PAGE_SIZE,
  ): Promise<CursorPage<Patient>> {
    const page = await this.patientRepository.findPage(context, {
      limit,
      afterId: cursor,
    });
    return {
      items: page.items.map(toPatientDto),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }
}
