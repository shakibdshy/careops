import type { Queue } from 'bullmq';
import { NotFoundException } from '@nestjs/common';
import type { CursorPage } from '@careops/shared';
import { PatientsService } from './patients.service.js';
import type { PatientRepository } from './patient.repository.js';
import { AuditService } from '../audit/audit.service.js';
import {
  patientCreatedJobId,
  type PatientCreatedJob,
} from '../notifications/notifications.tokens.js';
import type { PatientDoc } from './patient.schema.js';

const context = { organizationId: 'org-1' };
const actor = { id: 'user-1', email: 'owner@example.test' };

function patientDoc(overrides: Partial<Record<string, unknown>> = {}): PatientDoc {
  return {
    _id: 'p1',
    organizationId: 'org-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    dateOfBirth: new Date('1990-12-10'),
    phone: '555-0100',
    notes: 'first patient',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as unknown as PatientDoc;
}

function fakeRepo(
  overrides: Partial<{
    create: () => Promise<PatientDoc>;
    findOne: () => Promise<PatientDoc | null>;
    findPage: () => Promise<CursorPage<PatientDoc>>;
    findOneAndUpdate: () => Promise<PatientDoc | null>;
    findOneAndDelete: () => Promise<PatientDoc | null>;
  }>,
): PatientRepository {
  const base = {
    create: async () => patientDoc(),
    findOne: async () => patientDoc(),
    findPage: async () => ({ items: [patientDoc()], nextCursor: undefined, hasMore: false }),
    findOneAndUpdate: async () => patientDoc({ firstName: 'Edited' }),
    findOneAndDelete: async () => patientDoc(),
  };
  const merged = { ...base, ...overrides };
  return merged as unknown as PatientRepository;
}

function fakeQueue(): Queue<PatientCreatedJob> & { added: Array<Record<string, unknown>> } {
  const added: Array<Record<string, unknown>> = [];
  return {
    add: async (name: string, data: Record<string, unknown>, options?: Record<string, unknown>) => {
      added.push({ name, data, options });
      return {} as never;
    },
    added,
  } as unknown as Queue<PatientCreatedJob> & { added: Array<Record<string, unknown>> };
}

function fakeAudit(): AuditService & { records: unknown[] } {
  const records: unknown[] = [];
  const service = Object.create(AuditService.prototype) as AuditService & { records: unknown[] };
  service.record = async (capture: unknown) => {
    records.push(capture);
  };
  service.records = records;
  return service;
}

describe('PatientsService', () => {
  it('creates a patient and writes an audit entry with before=null', async () => {
    const audit = fakeAudit();
    const queue = fakeQueue();
    const service = new PatientsService(fakeRepo({}), audit, queue);
    const patient = await service.create(context, actor, {
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '1990-12-10',
      phone: '555-0100',
      notes: 'first patient',
    });
    expect(patient.id).toBe('p1');
    expect(patient.organizationId).toBe('org-1');
    expect(patient.dateOfBirth).toBe('1990-12-10T00:00:00.000Z');
    expect(audit.records).toHaveLength(1);
    const capture = audit.records[0] as {
      action: string;
      entity: string;
      before: unknown;
      after: { firstName: string };
    };
    expect(capture.action).toBe('create');
    expect(capture.entity).toBe('patient');
    expect(capture.before).toBeNull();
    expect(capture.after.firstName).toBe('Ada');
    expect(queue.added).toHaveLength(1);
    const job = queue.added[0] as {
      name: string;
      data: { patientId: string };
      options: { jobId: string };
    };
    expect(job.name).toBe('patient.created');
    expect(job.data.patientId).toBe('p1');
    expect(job.options.jobId).toBe(patientCreatedJobId('p1'));
  });

  it('returns a patient found within the organization', async () => {
    const service = new PatientsService(fakeRepo({}), fakeAudit(), fakeQueue());
    const patient = await service.findOne(context, 'p1');
    expect(patient.id).toBe('p1');
  });

  it('throws NotFound for a patient outside the organization', async () => {
    const service = new PatientsService(
      fakeRepo({ findOne: async () => null }),
      fakeAudit(),
      fakeQueue(),
    );
    await expect(service.findOne(context, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps a repository page into the cursor envelope', async () => {
    const service = new PatientsService(
      fakeRepo({
        findPage: async () => ({ items: [patientDoc()], nextCursor: 'p1', hasMore: true }),
      }),
      fakeAudit(),
      fakeQueue(),
    );
    const page = await service.listPage(context, undefined, 20);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('p1');
    expect(page.hasMore).toBe(true);
  });

  it('returns nextCursor undefined on the last page', async () => {
    const service = new PatientsService(fakeRepo({}), fakeAudit(), fakeQueue());
    const page = await service.listPage(context, undefined, 20);
    expect(page.nextCursor).toBeUndefined();
    expect(page.hasMore).toBe(false);
  });

  it('maps optional fields as undefined when absent', async () => {
    const service = new PatientsService(
      fakeRepo({
        create: async () => patientDoc({ phone: undefined, notes: undefined }),
      }),
      fakeAudit(),
      fakeQueue(),
    );
    const patient = await service.create(context, actor, {
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '1990-12-10',
    });
    expect(patient.phone).toBeUndefined();
    expect(patient.notes).toBeUndefined();
  });

  it('uses the provided cursor and limit for pagination', async () => {
    const observed: Array<{ limit: number; afterId: string | undefined }> = [];
    const repo = {
      findPage: async (_context: unknown, options: { limit: number; afterId?: string }) => {
        observed.push({ limit: options.limit, afterId: options.afterId });
        return { items: [], nextCursor: undefined, hasMore: false };
      },
    } as unknown as PatientRepository;
    const service = new PatientsService(repo, fakeAudit(), fakeQueue());
    await service.listPage(context, 'cursor-42', 5);
    expect(observed[0]).toEqual({ limit: 5, afterId: 'cursor-42' });
  });

  it('reports an empty last page without a cursor', async () => {
    const service = new PatientsService(
      fakeRepo({ findPage: async () => ({ items: [], nextCursor: undefined, hasMore: false }) }),
      fakeAudit(),
      fakeQueue(),
    );
    const page = await service.listPage(context, 'end-cursor', 20);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    expect(page.hasMore).toBe(false);
  });

  it('defaults the page size when none is provided', async () => {
    const observed: Array<{ limit: number; afterId: string | undefined }> = [];
    const repo = {
      findPage: async (_context: unknown, options: { limit: number; afterId?: string }) => {
        observed.push({ limit: options.limit, afterId: options.afterId });
        return { items: [], nextCursor: undefined, hasMore: false };
      },
    } as unknown as PatientRepository;
    const service = new PatientsService(repo, fakeAudit(), fakeQueue());
    await service.listPage(context);
    expect(observed[0]?.limit).toBe(20);
  });

  it('updates a patient and writes an audit entry with before→after', async () => {
    const audit = fakeAudit();
    const service = new PatientsService(
      fakeRepo({
        // returnPreUpdate semantics: findOneAndUpdate yields the PRE doc.
        findOneAndUpdate: async () => patientDoc(),
        findOne: async () => patientDoc({ firstName: 'Edited' }),
      }),
      audit,
      fakeQueue(),
    );
    const patient = await service.update(context, actor, 'p1', { firstName: 'Edited' });
    expect(patient.firstName).toBe('Edited');
    expect(audit.records).toHaveLength(1);
    const capture = audit.records[0] as {
      action: string;
      before: { firstName: string };
      after: { firstName: string };
    };
    expect(capture.action).toBe('update');
    expect(capture.before.firstName).toBe('Ada');
    expect(capture.after.firstName).toBe('Edited');
  });

  it('throws NotFound when updating a patient outside the organization', async () => {
    const service = new PatientsService(
      fakeRepo({ findOne: async () => null }),
      fakeAudit(),
      fakeQueue(),
    );
    await expect(
      service.update(context, actor, 'missing', { firstName: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes a patient and writes an audit entry retaining the before-state', async () => {
    const audit = fakeAudit();
    const queue = fakeQueue();
    const service = new PatientsService(fakeRepo({}), audit, queue);
    await service.remove(context, actor, 'p1');
    expect(audit.records).toHaveLength(1);
    const capture = audit.records[0] as {
      action: string;
      before: { firstName: string };
      after: unknown;
    };
    expect(capture.action).toBe('delete');
    expect(capture.before.firstName).toBe('Ada');
    expect(capture.after).toBeNull();
  });

  it('throws NotFound when deleting a patient outside the organization', async () => {
    const service = new PatientsService(
      fakeRepo({ findOneAndDelete: async () => null }),
      fakeAudit(),
      fakeQueue(),
    );
    await expect(service.remove(context, actor, 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
