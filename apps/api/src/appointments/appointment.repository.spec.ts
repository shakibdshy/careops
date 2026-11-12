import type { ClientSession, Model } from 'mongoose';
import { AppointmentRepository } from './appointment.repository.js';
import type { AppointmentDoc } from './appointment.schema.js';
import type { ProviderScheduleDocument } from './provider-schedule.schema.js';

const context = { organizationId: 'org-1' };
const session = {} as ClientSession;
const window = {
  memberId: 'member-1',
  start: new Date('2026-12-01T10:00:00.000Z'),
  end: new Date('2026-12-01T10:30:00.000Z'),
};

function fakeAppointmentModel(result: AppointmentDoc | null = null) {
  const seen: Array<{ filter: Record<string, unknown>; session: ClientSession }> = [];
  const model = {
    findOne: (filter: Record<string, unknown>) => ({
      session: (txSession: ClientSession) => ({
        exec: async () => {
          seen.push({ filter, session: txSession });
          return result;
        },
      }),
    }),
  };
  return { model: model as unknown as Model<AppointmentDoc>, seen };
}

function fakeUpdateModel(result: AppointmentDoc | null = null) {
  const seen: Array<{
    filter: Record<string, unknown>;
    update: Record<string, unknown>;
    options: Record<string, unknown>;
  }> = [];
  const model = {
    findOneAndUpdate: (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => ({
      exec: async () => {
        seen.push({ filter, update, options });
        return result;
      },
    }),
  };
  return { model: model as unknown as Model<AppointmentDoc>, seen };
}

function fakeScheduleModel() {
  const seen: Array<{
    filter: Record<string, unknown>;
    update: Record<string, unknown>;
    options: Record<string, unknown>;
  }> = [];
  const model = {
    findOneAndUpdate: (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => ({
      exec: async () => {
        seen.push({ filter, update, options });
        return null;
      },
    }),
  };
  return { model: model as unknown as Model<ProviderScheduleDocument>, seen };
}

describe('AppointmentRepository', () => {
  describe('findConflicting (the Conflict predicate)', () => {
    it('scopes the scan to the organization and the Provider', async () => {
      const { model, seen } = fakeAppointmentModel();
      const repository = new AppointmentRepository(model, fakeScheduleModel().model);

      await repository.findConflicting(context, window, session);

      expect(seen[0]?.filter['organizationId']).toBe('org-1');
      expect(seen[0]?.filter['memberId']).toBe('member-1');
    });

    it('expresses half-open [start, end) overlap: start < window.end and end > window.start', async () => {
      const { model, seen } = fakeAppointmentModel();
      const repository = new AppointmentRepository(model, fakeScheduleModel().model);

      await repository.findConflicting(context, window, session);

      expect(seen[0]?.filter['start']).toEqual({ $lt: window.end });
      expect(seen[0]?.filter['end']).toEqual({ $gt: window.start });
    });

    it('treats every status except CANCELLED and NO_SHOW as slot-holding', async () => {
      const { model, seen } = fakeAppointmentModel();
      const repository = new AppointmentRepository(model, fakeScheduleModel().model);

      await repository.findConflicting(context, window, session);

      expect(seen[0]?.filter['status']).toEqual({ $nin: ['CANCELLED', 'NO_SHOW'] });
    });

    it('runs the scan inside the caller’s transaction', async () => {
      const { model, seen } = fakeAppointmentModel();
      const repository = new AppointmentRepository(model, fakeScheduleModel().model);

      await repository.findConflicting(context, window, session);

      expect(seen[0]?.session).toBe(session);
    });

    it('excludes the appointment being rescheduled from the Conflict scan', async () => {
      const { model, seen } = fakeAppointmentModel();
      const repository = new AppointmentRepository(model, fakeScheduleModel().model);

      await repository.findConflicting(context, { ...window, excludeId: 'a1' }, session);

      expect(seen[0]?.filter['_id']).toEqual({ $ne: 'a1' });
    });

    it('does not constrain _id for a plain booking scan', async () => {
      const { model, seen } = fakeAppointmentModel();
      const repository = new AppointmentRepository(model, fakeScheduleModel().model);

      await repository.findConflicting(context, window, session);

      expect(seen[0]?.filter['_id']).toBeUndefined();
    });

    it('returns the conflicting document, or null when the slot is free', async () => {
      const conflict = { _id: 'a1' } as unknown as AppointmentDoc;
      const busy = new AppointmentRepository(
        fakeAppointmentModel(conflict).model,
        fakeScheduleModel().model,
      );
      const free = new AppointmentRepository(
        fakeAppointmentModel(null).model,
        fakeScheduleModel().model,
      );

      await expect(busy.findConflicting(context, window, session)).resolves.toBe(conflict);
      await expect(free.findConflicting(context, window, session)).resolves.toBeNull();
    });
  });

  describe('touchProviderSchedule (the booking serializer)', () => {
    it('upserts the organization+Provider row inside the transaction', async () => {
      const { model, seen } = fakeScheduleModel();
      const repository = new AppointmentRepository(fakeAppointmentModel().model, model);

      await repository.touchProviderSchedule(context, 'member-1', session);

      expect(seen[0]?.filter).toEqual({ organizationId: 'org-1', memberId: 'member-1' });
      const set = seen[0]?.update['$set'] as { updatedAt: Date };
      expect(set.updatedAt).toBeInstanceOf(Date);
      expect(seen[0]?.options).toEqual({ upsert: true, session });
    });
  });

  describe('createInTransaction', () => {
    it('injects the organization id and saves inside the caller’s transaction', async () => {
      const saved: Array<{ data: Record<string, unknown>; options: Record<string, unknown> }> = [];
      function FakeModel(
        this: { save: (options: Record<string, unknown>) => Promise<unknown> },
        data: Record<string, unknown>,
      ) {
        this.save = async (options: Record<string, unknown>) => {
          saved.push({ data, options });
          return { ...data, _id: 'a1' };
        };
      }
      const repository = new AppointmentRepository(
        FakeModel as unknown as Model<AppointmentDoc>,
        fakeScheduleModel().model,
      );
      const data = {
        patientId: 'p1',
        memberId: 'member-1',
        start: window.start,
        end: window.end,
        durationMinutes: 30,
        status: 'SCHEDULED',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await repository.createInTransaction(context, data, session);

      expect(saved[0]?.data).toEqual({ ...data, organizationId: 'org-1' });
      expect(saved[0]?.options).toEqual({ session });
    });
  });

  describe('findOneInTransaction', () => {
    it('scopes the snapshot read to the organization inside the caller’s transaction', async () => {
      const doc = { _id: 'a1' } as unknown as AppointmentDoc;
      const { model, seen } = fakeAppointmentModel(doc);
      const repository = new AppointmentRepository(model, fakeScheduleModel().model);

      const found = await repository.findOneInTransaction(context, { _id: 'a1' }, session);

      expect(found).toBe(doc);
      expect(seen[0]?.filter).toEqual({ _id: 'a1', organizationId: 'org-1' });
      expect(seen[0]?.session).toBe(session);
    });
  });

  describe('updateInTransaction', () => {
    it('applies the update scoped to the organization inside the caller’s transaction', async () => {
      const doc = { _id: 'a1', status: 'CONFIRMED' } as unknown as AppointmentDoc;
      const { model, seen } = fakeUpdateModel(doc);
      const repository = new AppointmentRepository(model, fakeScheduleModel().model);

      const updated = await repository.updateInTransaction(
        context,
        { _id: 'a1', status: 'SCHEDULED' },
        { status: 'CONFIRMED' },
        session,
      );

      expect(updated).toBe(doc);
      expect(seen[0]?.filter).toEqual({ _id: 'a1', status: 'SCHEDULED', organizationId: 'org-1' });
      expect(seen[0]?.update).toEqual({ status: 'CONFIRMED' });
      expect(seen[0]?.options).toEqual({ new: true, session });
    });

    it('returnPreUpdate yields the pre-update document for the audit capture', async () => {
      const { model, seen } = fakeUpdateModel();
      const repository = new AppointmentRepository(model, fakeScheduleModel().model);

      await repository.updateInTransaction(
        context,
        { _id: 'a1' },
        { start: window.start },
        session,
        {
          returnPreUpdate: true,
        },
      );

      expect(seen[0]?.options).toEqual({ new: false, session });
    });
  });
});
