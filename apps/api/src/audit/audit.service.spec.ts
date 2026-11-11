import type { Model } from 'mongoose';
import { AuditService } from './audit.service.js';
import type { AuditEntryDoc } from './audit-entry.schema.js';

function auditDoc(): AuditEntryDoc {
  return {
    _id: 'a1',
    organizationId: 'org-1',
    actorId: 'user-1',
    actorEmail: 'owner@example.test',
    action: 'create',
    entity: 'patient',
    entityId: 'p1',
    before: null,
    after: { firstName: 'Ada' },
    at: new Date('2026-01-01T00:00:00Z'),
  } as unknown as AuditEntryDoc;
}

function fakeModel(): Model<AuditEntryDoc> & { created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  const model = Object.assign(
    async (data: Record<string, unknown>) => {
      created.push(data);
      return auditDoc();
    },
    {
      created,
      create: async (data: Record<string, unknown>) => {
        created.push(data);
        return auditDoc();
      },
    },
  );
  return model as unknown as Model<AuditEntryDoc> & {
    created: Array<Record<string, unknown>>;
  };
}

describe('AuditService', () => {
  it('maps an audit document into the shared contract', () => {
    const service = Object.create(AuditService.prototype) as AuditService;
    const dto = service.toDto(auditDoc());
    expect(dto).toEqual({
      id: 'a1',
      organizationId: 'org-1',
      actorId: 'user-1',
      actorEmail: 'owner@example.test',
      action: 'create',
      entity: 'patient',
      entityId: 'p1',
      before: null,
      after: { firstName: 'Ada' },
      at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('records an append-only entry scoped to the organization and actor', async () => {
    const model = fakeModel();
    const service = new AuditService(model);
    await service.record({
      context: { organizationId: 'org-1' },
      actor: { id: 'user-1', email: 'owner@example.test' },
      action: 'delete',
      entity: 'patient',
      entityId: 'p2',
      before: { firstName: 'Ada' },
      after: null,
    });
    expect(model.created).toHaveLength(1);
    expect(model.created[0]).toMatchObject({
      organizationId: 'org-1',
      actorId: 'user-1',
      actorEmail: 'owner@example.test',
      action: 'delete',
      entity: 'patient',
      entityId: 'p2',
      before: { firstName: 'Ada' },
      after: null,
    });
  });
});
