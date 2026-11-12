import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ClientSession, Connection } from 'mongoose';
import type { OrgRequestContext } from '../data/org-scoped.repository.js';
import type { CursorPage } from '@careops/shared';
import { AppointmentsService } from './appointments.service.js';
import type { AppointmentRepository } from './appointment.repository.js';
import type { AppointmentDoc } from './appointment.schema.js';
import type { AppointmentDocument } from './appointment.schema.js';
import type { BookingWindow } from './appointment.repository.js';
import type { PatientRepository } from '../patients/patient.repository.js';
import type { PatientDoc } from '../patients/patient.schema.js';
import { AuditService } from '../audit/audit.service.js';
import type { FullOrganization } from '../auth/org-context.js';

const context = { organizationId: 'org-1' };
const actor = { id: 'user-1', email: 'owner@example.test' };
const members: FullOrganization['members'] = [
  { id: 'member-1', userId: 'user-1', role: 'owner', user: { email: actor.email, name: 'Owner' } },
  {
    id: 'member-2',
    userId: 'user-2',
    role: 'admin',
    user: { email: 'admin@example.test', name: 'Admin' },
  },
];

const validCreate = {
  patientId: 'p1',
  memberId: 'member-2',
  start: '2026-11-20T10:00:00.000Z',
  durationMinutes: 30,
} as const;

function appointmentDoc(overrides: Partial<Record<string, unknown>> = {}): AppointmentDoc {
  return {
    _id: 'a1',
    organizationId: 'org-1',
    patientId: 'p1',
    memberId: 'member-2',
    start: new Date('2026-11-20T10:00:00.000Z'),
    end: new Date('2026-11-20T10:30:00.000Z'),
    durationMinutes: 30,
    status: 'SCHEDULED',
    notes: undefined,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as unknown as AppointmentDoc;
}

function patientDoc(): PatientDoc {
  return {
    _id: 'p1',
    organizationId: 'org-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    dateOfBirth: new Date('1990-12-10'),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as PatientDoc;
}

type FindPageOptions = Parameters<AppointmentRepository['findPage']>[1];

type RepoOverrides = Partial<{
  findConflicting: (
    context: OrgRequestContext,
    window: BookingWindow,
    session: ClientSession,
  ) => Promise<AppointmentDoc | null>;
  touchProviderSchedule: (
    context: OrgRequestContext,
    memberId: string,
    session: ClientSession,
  ) => Promise<void>;
  createInTransaction: (
    context: OrgRequestContext,
    data: Omit<AppointmentDocument, 'organizationId'>,
    session: ClientSession,
  ) => Promise<AppointmentDoc>;
  findOne: () => Promise<AppointmentDoc | null>;
  findPage: (
    context: OrgRequestContext,
    options: FindPageOptions,
  ) => Promise<CursorPage<AppointmentDoc>>;
  findOneAndUpdate: (
    context: OrgRequestContext,
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { returnPreUpdate?: boolean },
  ) => Promise<AppointmentDoc | null>;
  findOneInTransaction: (
    context: OrgRequestContext,
    filter: Record<string, unknown>,
    session: ClientSession,
  ) => Promise<AppointmentDoc | null>;
  updateInTransaction: (
    context: OrgRequestContext,
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    session: ClientSession,
    options: { returnPreUpdate?: boolean },
  ) => Promise<AppointmentDoc | null>;
}>;

function fakeRepo(overrides: RepoOverrides = {}): AppointmentRepository {
  const base = {
    findConflicting: async () => null,
    touchProviderSchedule: async () => undefined,
    createInTransaction: async () => appointmentDoc(),
    findOne: async () => appointmentDoc(),
    findPage: async () => ({ items: [appointmentDoc()], nextCursor: undefined, hasMore: false }),
    findOneAndUpdate: async () => appointmentDoc(),
    findOneInTransaction: async () => appointmentDoc(),
    updateInTransaction: async () => appointmentDoc(),
  };
  return { ...base, ...overrides } as unknown as AppointmentRepository;
}

function conflictResponse(error: unknown): {
  message: string;
  errors: Array<{ field: string; message: string }>;
} {
  expect(error).toBeInstanceOf(ConflictException);
  return (error as ConflictException).getResponse() as {
    message: string;
    errors: Array<{ field: string; message: string }>;
  };
}

function fakePatientRepo(found: boolean): PatientRepository {
  return {
    findOne: async () => (found ? patientDoc() : null),
  } as unknown as PatientRepository;
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

/** Executes the transaction callback inline, like a healthy replica set. */
function fakeConnection(): Connection {
  const session = {
    withTransaction: async <T>(fn: (txSession: ClientSession) => Promise<T>): Promise<T> =>
      fn({} as ClientSession),
    endSession: async () => undefined,
  } as unknown as ClientSession;
  return {
    getClient: () => ({ startSession: () => session }),
  } as unknown as Connection;
}

/** Simulates a transaction that aborts without an application error. */
function abortingConnection(): Connection {
  const session = {
    withTransaction: async () => undefined,
    endSession: async () => undefined,
  } as unknown as ClientSession;
  return {
    getClient: () => ({ startSession: () => session }),
  } as unknown as Connection;
}

describe('AppointmentsService', () => {
  it('books an appointment: derives end, persists SCHEDULED, audits null→after', async () => {
    const audit = fakeAudit();
    const inserts: Array<Record<string, unknown>> = [];
    const service = new AppointmentsService(
      fakeRepo({
        createInTransaction: async (
          _context: OrgRequestContext,
          data: Omit<AppointmentDocument, 'organizationId'>,
        ) => {
          inserts.push({ ...data });
          return appointmentDoc();
        },
      }),
      fakePatientRepo(true),
      audit,
      fakeConnection(),
    );

    const appointment = await service.create(context, members, actor, { ...validCreate });

    expect(appointment.status).toBe('SCHEDULED');
    expect(appointment.start).toBe('2026-11-20T10:00:00.000Z');
    const insert = inserts[0];
    expect(insert?.['end']).toEqual(new Date('2026-11-20T10:30:00.000Z'));
    expect(audit.records).toHaveLength(1);
  });

  it('rejects an unknown Provider member with 404', async () => {
    const service = new AppointmentsService(
      fakeRepo(),
      fakePatientRepo(true),
      fakeAudit(),
      fakeConnection(),
    );
    await expect(
      service.create(context, members, actor, { ...validCreate, memberId: '0'.repeat(24) }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects an unknown Patient with 404', async () => {
    const service = new AppointmentsService(
      fakeRepo(),
      fakePatientRepo(false),
      fakeAudit(),
      fakeConnection(),
    );
    await expect(service.create(context, members, actor, { ...validCreate })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects an overlapping booking with 409 and writes no audit entry', async () => {
    const audit = fakeAudit();
    const service = new AppointmentsService(
      fakeRepo({ findConflicting: async () => appointmentDoc() }),
      fakePatientRepo(true),
      audit,
      fakeConnection(),
    );
    await expect(service.create(context, members, actor, { ...validCreate })).rejects.toThrow(
      ConflictException,
    );
    expect(audit.records).toHaveLength(0);
  });

  it('persists notes when provided', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const service = new AppointmentsService(
      fakeRepo({
        createInTransaction: async (
          _context: OrgRequestContext,
          data: Omit<AppointmentDocument, 'organizationId'>,
        ) => {
          inserts.push({ ...data });
          return appointmentDoc({ notes: 'bring chart' });
        },
      }),
      fakePatientRepo(true),
      fakeAudit(),
      fakeConnection(),
    );
    await service.create(context, members, actor, { ...validCreate, notes: 'bring chart' });
    expect(inserts[0]?.['notes']).toBe('bring chart');
  });

  it('is 409 when the transaction aborts without an application error', async () => {
    const service = new AppointmentsService(
      fakeRepo(),
      fakePatientRepo(true),
      fakeAudit(),
      abortingConnection(),
    );
    await expect(service.create(context, members, actor, { ...validCreate })).rejects.toThrow(
      ConflictException,
    );
  });

  it('findOne returns the appointment', async () => {
    const service = new AppointmentsService(
      fakeRepo(),
      fakePatientRepo(true),
      fakeAudit(),
      fakeConnection(),
    );
    const appointment = await service.findOne(context, 'a1');
    expect(appointment.id).toBe('a1');
  });

  it('findOne is 404 for an appointment outside the organization', async () => {
    const service = new AppointmentsService(
      fakeRepo({ findOne: async () => null }),
      fakePatientRepo(true),
      fakeAudit(),
      fakeConnection(),
    );
    await expect(service.findOne(context, 'missing')).rejects.toThrow(NotFoundException);
  });

  it('listPage maps docs and passes cursor', async () => {
    const service = new AppointmentsService(
      fakeRepo({
        findPage: async () => ({
          items: [appointmentDoc(), appointmentDoc({ _id: 'a2' })],
          nextCursor: 'a2',
          hasMore: true,
        }),
      }),
      fakePatientRepo(true),
      fakeAudit(),
      fakeConnection(),
    );
    const page = await service.listPage(context, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe('a2');
    expect(page.hasMore).toBe(true);
  });

  it('listPage passes status, provider, and window filters', async () => {
    const seen: FindPageOptions[] = [];
    const service = new AppointmentsService(
      fakeRepo({
        findPage: async (_context, options) => {
          seen.push(options);
          return { items: [], nextCursor: undefined, hasMore: false };
        },
      }),
      fakePatientRepo(true),
      fakeAudit(),
      fakeConnection(),
    );
    await service.listPage(context, {
      status: 'CONFIRMED',
      memberId: 'member-2',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-30T00:00:00.000Z',
      limit: 5,
    });
    const options = seen[0];
    expect(options?.filter?.['status']).toBe('CONFIRMED');
    expect(options?.filter?.['memberId']).toBe('member-2');
    expect(options?.filter?.['start']).toEqual({
      $gte: new Date('2026-11-01T00:00:00.000Z'),
      $lte: new Date('2026-11-30T00:00:00.000Z'),
    });
    expect(options?.limit).toBe(5);
  });

  it('listPage passes one-sided windows', async () => {
    const seen: FindPageOptions[] = [];
    const service = new AppointmentsService(
      fakeRepo({
        findPage: async (_context, options) => {
          seen.push(options);
          return { items: [], nextCursor: undefined, hasMore: false };
        },
      }),
      fakePatientRepo(true),
      fakeAudit(),
      fakeConnection(),
    );
    await service.listPage(context, { from: '2026-11-01T00:00:00.000Z', limit: 20 });
    await service.listPage(context, { to: '2026-11-30T00:00:00.000Z', limit: 20 });
    expect(seen[0]?.filter).toEqual({
      start: { $gte: new Date('2026-11-01T00:00:00.000Z') },
    });
    expect(seen[1]?.filter).toEqual({
      start: { $lte: new Date('2026-11-30T00:00:00.000Z') },
    });
  });

  describe('transition', () => {
    it('applies an allowed transition with a status compare-and-swap and audits before→after', async () => {
      const audit = fakeAudit();
      const updates: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> =
        [];
      const reads = [appointmentDoc(), appointmentDoc({ status: 'CONFIRMED' })];
      const service = new AppointmentsService(
        fakeRepo({
          findOne: async () => reads.shift() ?? null,
          findOneAndUpdate: async (_context, filter, update) => {
            updates.push({ filter, update });
            return appointmentDoc();
          },
        }),
        fakePatientRepo(true),
        audit,
        fakeConnection(),
      );

      const result = await service.transition(context, actor, 'a1', 'CONFIRMED');

      expect(result.status).toBe('CONFIRMED');
      expect(updates[0]?.filter).toEqual({ _id: 'a1', status: 'SCHEDULED' });
      expect(updates[0]?.update['status']).toBe('CONFIRMED');
      expect(audit.records).toHaveLength(1);
      const capture = audit.records[0] as {
        action: string;
        before: { status: string };
        after: { status: string };
      };
      expect(capture.action).toBe('update');
      expect(capture.before.status).toBe('SCHEDULED');
      expect(capture.after.status).toBe('CONFIRMED');
    });

    it('rejects an illegal jump with 409 naming the allowed targets', async () => {
      const service = new AppointmentsService(
        fakeRepo({ findOne: async () => appointmentDoc({ status: 'CHECKED_IN' }) }),
        fakePatientRepo(true),
        fakeAudit(),
        fakeConnection(),
      );
      const error = await service
        .transition(context, actor, 'a1', 'NO_SHOW')
        .catch((e: unknown) => e);
      const response = conflictResponse(error);
      expect(response.errors[0]?.field).toBe('status');
      for (const allowed of ['IN_PROGRESS', 'COMPLETED', 'CANCELLED']) {
        expect(response.errors[0]?.message).toContain(allowed);
      }
      expect(response.errors[0]?.message).not.toContain('NO_SHOW');
    });

    it('terminal statuses reject every target as none (terminal status)', async () => {
      for (const terminal of ['COMPLETED', 'CANCELLED', 'NO_SHOW'] as const) {
        const service = new AppointmentsService(
          fakeRepo({ findOne: async () => appointmentDoc({ status: terminal }) }),
          fakePatientRepo(true),
          fakeAudit(),
          fakeConnection(),
        );
        const error = await service
          .transition(context, actor, 'a1', 'CONFIRMED')
          .catch((e: unknown) => e);
        expect(conflictResponse(error).errors[0]?.message).toContain('none (terminal status)');
      }
    });

    it('is 404 for an appointment outside the organization', async () => {
      const service = new AppointmentsService(
        fakeRepo({ findOne: async () => null }),
        fakePatientRepo(true),
        fakeAudit(),
        fakeConnection(),
      );
      await expect(service.transition(context, actor, 'missing', 'CONFIRMED')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('is 409 naming the current allowed targets when a concurrent transition won the CAS', async () => {
      const reads = [appointmentDoc(), appointmentDoc({ status: 'CANCELLED' })];
      const service = new AppointmentsService(
        fakeRepo({
          findOne: async () => reads.shift() ?? null,
          findOneAndUpdate: async () => null,
        }),
        fakePatientRepo(true),
        fakeAudit(),
        fakeConnection(),
      );
      const error = await service
        .transition(context, actor, 'a1', 'CONFIRMED')
        .catch((e: unknown) => e);
      expect(conflictResponse(error).errors[0]?.message).toContain('none (terminal status)');
    });
  });

  describe('reschedule', () => {
    it('merges partial fields, excludes itself from the Conflict scan, and audits before→after', async () => {
      const audit = fakeAudit();
      const windows: BookingWindow[] = [];
      const updates: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> =
        [];
      const service = new AppointmentsService(
        fakeRepo({
          findConflicting: async (_context, window) => {
            windows.push(window);
            return null;
          },
          updateInTransaction: async (_context, filter, update) => {
            updates.push({ filter, update });
            return appointmentDoc();
          },
          findOne: async () =>
            appointmentDoc({
              start: new Date('2026-11-20T11:00:00.000Z'),
              end: new Date('2026-11-20T11:30:00.000Z'),
            }),
        }),
        fakePatientRepo(true),
        audit,
        fakeConnection(),
      );

      const result = await service.reschedule(context, members, actor, 'a1', {
        start: '2026-11-20T11:00:00.000Z',
      });

      expect(result.start).toBe('2026-11-20T11:00:00.000Z');
      expect(windows[0]).toEqual({
        memberId: 'member-2',
        start: new Date('2026-11-20T11:00:00.000Z'),
        end: new Date('2026-11-20T11:30:00.000Z'),
        excludeId: 'a1',
      });
      expect(updates[0]?.filter).toEqual({
        _id: 'a1',
        status: { $in: ['SCHEDULED', 'CONFIRMED'] },
      });
      expect(updates[0]?.update['durationMinutes']).toBe(30);
      expect(updates[0]?.update['memberId']).toBe('member-2');
      expect(audit.records).toHaveLength(1);
      const capture = audit.records[0] as {
        action: string;
        before: { start: string };
        after: { start: string };
      };
      expect(capture.action).toBe('update');
      expect(capture.before.start).toBe('2026-11-20T10:00:00.000Z');
      expect(capture.after.start).toBe('2026-11-20T11:00:00.000Z');
    });

    it('derives end from the new duration when only duration changes', async () => {
      const windows: BookingWindow[] = [];
      const service = new AppointmentsService(
        fakeRepo({
          findConflicting: async (_context, window) => {
            windows.push(window);
            return null;
          },
        }),
        fakePatientRepo(true),
        fakeAudit(),
        fakeConnection(),
      );
      await service.reschedule(context, members, actor, 'a1', { durationMinutes: 60 });
      expect(windows[0]?.start).toEqual(new Date('2026-11-20T10:00:00.000Z'));
      expect(windows[0]?.end).toEqual(new Date('2026-11-20T11:00:00.000Z'));
    });

    it('serializes on the new Provider when memberId changes', async () => {
      const touched: string[] = [];
      const windows: BookingWindow[] = [];
      const service = new AppointmentsService(
        fakeRepo({
          touchProviderSchedule: async (_context, memberId) => {
            touched.push(memberId);
          },
          findConflicting: async (_context, window) => {
            windows.push(window);
            return null;
          },
        }),
        fakePatientRepo(true),
        fakeAudit(),
        fakeConnection(),
      );
      await service.reschedule(context, members, actor, 'a1', { memberId: 'member-1' });
      expect(touched).toEqual(['member-1']);
      expect(windows[0]?.memberId).toBe('member-1');
    });

    it('rejects rescheduling out of SCHEDULED/CONFIRMED with 409 and writes no audit', async () => {
      for (const status of [
        'CHECKED_IN',
        'IN_PROGRESS',
        'COMPLETED',
        'CANCELLED',
        'NO_SHOW',
      ] as const) {
        const audit = fakeAudit();
        const service = new AppointmentsService(
          fakeRepo({ findOneInTransaction: async () => appointmentDoc({ status }) }),
          fakePatientRepo(true),
          audit,
          fakeConnection(),
        );
        const error = await service
          .reschedule(context, members, actor, 'a1', { durationMinutes: 45 })
          .catch((e: unknown) => e);
        expect(conflictResponse(error).message).toContain(status);
        expect(audit.records).toHaveLength(0);
      }
    });

    it('rejects an overlapping new slot with 409 and writes no audit', async () => {
      const audit = fakeAudit();
      const service = new AppointmentsService(
        fakeRepo({ findConflicting: async () => appointmentDoc() }),
        fakePatientRepo(true),
        audit,
        fakeConnection(),
      );
      const error = await service
        .reschedule(context, members, actor, 'a1', { start: '2026-11-20T10:15:00.000Z' })
        .catch((e: unknown) => e);
      expect(conflictResponse(error).message).toMatch(/overlap/i);
      expect(audit.records).toHaveLength(0);
    });

    it('is 404 when the new Provider member is not in the organization', async () => {
      const service = new AppointmentsService(
        fakeRepo(),
        fakePatientRepo(true),
        fakeAudit(),
        fakeConnection(),
      );
      await expect(
        service.reschedule(context, members, actor, 'a1', { memberId: 'missing' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('is 404 for an appointment outside the organization', async () => {
      const service = new AppointmentsService(
        fakeRepo({ findOneInTransaction: async () => null }),
        fakePatientRepo(true),
        fakeAudit(),
        fakeConnection(),
      );
      await expect(
        service.reschedule(context, members, actor, 'missing', { durationMinutes: 45 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('is 409 when a concurrent transition wins the state CAS', async () => {
      const service = new AppointmentsService(
        fakeRepo({ updateInTransaction: async () => null }),
        fakePatientRepo(true),
        fakeAudit(),
        fakeConnection(),
      );
      const error = await service
        .reschedule(context, members, actor, 'a1', { durationMinutes: 45 })
        .catch((e: unknown) => e);
      expect(conflictResponse(error).message).toMatch(/concurrently/i);
    });

    it('is 409 when the transaction aborts without an application error', async () => {
      const service = new AppointmentsService(
        fakeRepo(),
        fakePatientRepo(true),
        fakeAudit(),
        abortingConnection(),
      );
      await expect(
        service.reschedule(context, members, actor, 'a1', { durationMinutes: 45 }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
