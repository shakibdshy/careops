// Patients conformance cases (Go-T07) — ported from the reference API's
// patients e2e suite. Same meanings, black-box seam: create/list/pagination,
// tenant isolation (404 semantics), Manager-only mutations, the Contact
// Email field, and the audit trail browsed through the API. The one source
// expectation that read the datastore directly is ported through the audit
// listing endpoint (its own comment notes the endpoint supersedes it).
import { beforeAll, describe, expect, it } from 'bun:test';
import { auditEntriesPageSchema, patientSchema, patientsPageSchema } from '@careops/shared';
import { expectTaxonomy, ledgerProbe, parseBody, Session } from './helpers.js';

const validPatient = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  dateOfBirth: '1990-12-10',
  phone: '555-0100',
  notes: 'first patient',
};

describe('patients (conformance)', () => {
  const AREA = 'patients';

  let owner: Session;
  let member: Session;
  let stranger: Session;

  beforeAll(async () => {
    await ledgerProbe(AREA, async () => {
      owner = await Session.signUp('Patients Owner');
      member = await Session.signUp('Patients Member');
      stranger = await Session.signUp('Patients Stranger');
      // Member joins the owner's Organization.
      const invitation = await owner.post('/api/organizations/invitations', {
        email: member.email,
        role: 'member',
      });
      expect(invitation.status).toBe(201);
      const accept = await member.post('/api/auth/organization/accept-invitation', {
        invitationId: ((await invitation.json()) as { id: string }).id,
      });
      expect(accept.status).toBe(200);
    });
  });

  describe('create', () => {
    it('an owner creates a patient; the response matches the shared contract', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.post('/api/patients', validPatient);
        expect(res.status).toBe(201);
        const patient = parseBody(patientSchema, await res.json());
        expect(patient.firstName).toBe('Ada');
        expect(patient.lastName).toBe('Lovelace');
        expect(patient.dateOfBirth).toBe('1990-12-10T00:00:00.000Z');
      });
    });

    it('a member cannot create patients (403, shared taxonomy)', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await member.post('/api/patients', validPatient);
        await expectTaxonomy(res, 403);
      });
    });

    it('an invalid payload fails with field-level errors in the shared taxonomy', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.post('/api/patients', {
          firstName: '',
          lastName: 'Doe',
          dateOfBirth: 'not-a-date',
        });
        expect(res.status).toBe(400);
        const parsed = await expectTaxonomy(res, 400);
        const fields = parsed.errors.map((error) => error.field);
        expect(fields).toContain('firstName');
        expect(fields).toContain('dateOfBirth');
      });
    });

    it('rejects a future date of birth', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.post('/api/patients', {
          ...validPatient,
          dateOfBirth: '2999-01-01',
        });
        const parsed = await expectTaxonomy(res, 400);
        expect(parsed.errors.some((error) => error.field === 'dateOfBirth')).toBe(true);
      });
    });

    it('an unauthenticated create is denied with 401', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await Session.anonymous().post('/api/patients', validPatient);
        await expectTaxonomy(res, 401);
      });
    });
  });

  describe('list + cursor pagination', () => {
    beforeAll(async () => {
      // Two more patients so pagination has >1 page at limit 2 (3 total).
      await ledgerProbe(AREA, async () => {
        expect(
          (
            await owner.post('/api/patients', {
              ...validPatient,
              firstName: 'Grace',
              lastName: 'Hopper',
            })
          ).status,
        ).toBe(201);
        expect(
          (
            await owner.post('/api/patients', {
              ...validPatient,
              firstName: 'Alan',
              lastName: 'Turing',
            })
          ).status,
        ).toBe(201);
      });
    });

    it('a member lists patients within their organization', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await member.get('/api/patients?limit=2');
        expect(res.status).toBe(200);
        const page = parseBody(patientsPageSchema, await res.json());
        expect(page.items.length).toBe(2);
        expect(page.hasMore).toBe(true);
        expect(page.nextCursor).toBeDefined();
      });
    });

    it('following the cursor yields the remaining page without overlap', async () => {
      await ledgerProbe(AREA, async () => {
        const first = parseBody(
          patientsPageSchema,
          await (await member.get('/api/patients?limit=2')).json(),
        );
        const second = parseBody(
          patientsPageSchema,
          await (await member.get(`/api/patients?limit=2&cursor=${first.nextCursor}`)).json(),
        );
        expect(second.items.length).toBe(1);
        const firstIds = first.items.map((patient) => patient.id);
        const secondIds = second.items.map((patient) => patient.id);
        expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
        expect([...firstIds, ...secondIds]).toHaveLength(3);
      });
    });

    it('every returned patient validates against the shared schema', async () => {
      await ledgerProbe(AREA, async () => {
        const page = parseBody(
          patientsPageSchema,
          await (await member.get('/api/patients?limit=100')).json(),
        );
        expect(page.items.length).toBe(3);
        for (const patient of page.items) {
          parseBody(patientSchema, patient);
        }
      });
    });
  });

  describe('tenant isolation', () => {
    let strangerPatientId = '';

    beforeAll(async () => {
      await ledgerProbe(AREA, async () => {
        // Organization B (the stranger) creates their own patient.
        const res = await stranger.post('/api/patients', validPatient);
        expect(res.status).toBe(201);
        strangerPatientId = ((await res.json()) as { id: string }).id;
      });
    });

    it("organization A's list never contains organization B's patients", async () => {
      await ledgerProbe(AREA, async () => {
        const page = parseBody(
          patientsPageSchema,
          await (await owner.get('/api/patients?limit=100')).json(),
        );
        expect(page.items.map((patient) => patient.id)).not.toContain(strangerPatientId);
      });
    });

    it('a direct fetch of another organization’s patient is a 404, not a 403', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.get(`/api/patients/${strangerPatientId}`);
        await expectTaxonomy(res, 404);
      });
    });

    it('a cross-organization update is a 404', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.patch(`/api/patients/${strangerPatientId}`, {
          firstName: 'Hijacked',
        });
        await expectTaxonomy(res, 404);
      });
    });

    it('a cross-organization delete is a 404 and leaves the patient intact', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.delete(`/api/patients/${strangerPatientId}`);
        await expectTaxonomy(res, 404);
        const stillThere = await stranger.get(`/api/patients/${strangerPatientId}`);
        expect(stillThere.status).toBe(200);
        expect(parseBody(patientSchema, await stillThere.json()).firstName).toBe('Ada');
      });
    });
  });

  describe('update + delete (admin/owner)', () => {
    let patientId = '';

    beforeAll(async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.post('/api/patients', {
          ...validPatient,
          firstName: 'Edit',
          lastName: 'Me',
        });
        expect(res.status).toBe(201);
        patientId = ((await res.json()) as { id: string }).id;
      });
    });

    it('an owner updates a patient; the response matches the contract', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.patch(`/api/patients/${patientId}`, {
          firstName: 'Edited',
          phone: '555-9999',
        });
        expect(res.status).toBe(200);
        const patient = parseBody(patientSchema, await res.json());
        expect(patient.firstName).toBe('Edited');
        expect(patient.lastName).toBe('Me');
        expect(patient.phone).toBe('555-9999');
      });
    });

    it('a member cannot update (403)', async () => {
      await ledgerProbe(AREA, async () => {
        await expectTaxonomy(
          await member.patch(`/api/patients/${patientId}`, { firstName: 'Nope' }),
          403,
        );
      });
    });

    it('a member cannot delete (403)', async () => {
      await ledgerProbe(AREA, async () => {
        await expectTaxonomy(await member.delete(`/api/patients/${patientId}`), 403);
      });
    });

    it('an owner deletes a patient; the record disappears', async () => {
      await ledgerProbe(AREA, async () => {
        expect((await owner.delete(`/api/patients/${patientId}`)).status).toBe(200);
        await expectTaxonomy(await owner.get(`/api/patients/${patientId}`), 404);
      });
    });

    it('deleting a missing patient is a 404', async () => {
      await ledgerProbe(AREA, async () => {
        await expectTaxonomy(await owner.delete(`/api/patients/${patientId}`), 404);
      });
    });
  });

  describe('contact email (optional notification destination)', () => {
    it('is returned when provided on create and absent otherwise', async () => {
      await ledgerProbe(AREA, async () => {
        const withEmail = await owner.post('/api/patients', {
          ...validPatient,
          firstName: 'Email',
          lastName: 'Holder',
          contactEmail: 'holder@example.test',
        });
        expect(withEmail.status).toBe(201);
        expect(parseBody(patientSchema, await withEmail.json()).contactEmail).toBe(
          'holder@example.test',
        );

        const without = await owner.post('/api/patients', {
          ...validPatient,
          firstName: 'No',
          lastName: 'Email',
        });
        expect(without.status).toBe(201);
        expect(parseBody(patientSchema, await without.json()).contactEmail).toBeUndefined();
      });
    });

    it('can be added on update', async () => {
      await ledgerProbe(AREA, async () => {
        const created = await owner.post('/api/patients', {
          ...validPatient,
          firstName: 'Late',
          lastName: 'Contact',
        });
        expect(created.status).toBe(201);
        const id = ((await created.json()) as { id: string }).id;
        const res = await owner.patch(`/api/patients/${id}`, {
          contactEmail: 'late.contact@example.test',
        });
        expect(res.status).toBe(200);
        expect(parseBody(patientSchema, await res.json()).contactEmail).toBe(
          'late.contact@example.test',
        );
      });
    });

    it('rejects a malformed address with a contactEmail field error', async () => {
      await ledgerProbe(AREA, async () => {
        const create = await owner.post('/api/patients', {
          ...validPatient,
          contactEmail: 'not-an-email',
        });
        expect(create.status).toBe(400);
        expect(
          (await expectTaxonomy(create, 400)).errors.some(
            (error) => error.field === 'contactEmail',
          ),
        ).toBe(true);

        const created = await owner.post('/api/patients', {
          ...validPatient,
          firstName: 'Bad',
          lastName: 'Patch',
        });
        expect(created.status).toBe(201);
        const id = ((await created.json()) as { id: string }).id;
        const update = await owner.patch(`/api/patients/${id}`, { contactEmail: 'not-an-email' });
        expect(update.status).toBe(400);
        expect(
          (await expectTaxonomy(update, 400)).errors.some(
            (error) => error.field === 'contactEmail',
          ),
        ).toBe(true);
      });
    });
  });

  describe('audit browsing (owner/admin)', () => {
    it('an owner sees the audit trail newest-first with before→after states', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.get('/api/audit-entries?limit=100');
        expect(res.status).toBe(200);
        const page = parseBody(auditEntriesPageSchema, await res.json());
        expect(page.items.length).toBeGreaterThanOrEqual(4);
        // One of the deleted patient's entries: full before-state, null after.
        const deleted = page.items.find(
          (entry) => entry.action === 'delete' && entry.after === null,
        );
        expect(deleted).toBeDefined();
        expect(deleted?.before).toMatchObject({ firstName: 'Edited' });
        // An update entry carries both states (the Edit→Edited rename above;
        // other describes may add unrelated updates, so match on the after-state).
        const updated = page.items.find(
          (entry) =>
            entry.action === 'update' &&
            (entry.after as { firstName?: string } | null)?.firstName === 'Edited',
        );
        expect(updated?.before).toMatchObject({ firstName: 'Edit' });
        expect(updated?.after).toMatchObject({ firstName: 'Edited' });
      });
    });

    it('a member cannot browse the audit trail (403)', async () => {
      await ledgerProbe(AREA, async () => {
        await expectTaxonomy(await member.get('/api/audit-entries'), 403);
      });
    });

    it('audit entries are cursor-paginated', async () => {
      await ledgerProbe(AREA, async () => {
        const first = parseBody(
          auditEntriesPageSchema,
          await (await owner.get('/api/audit-entries?limit=2')).json(),
        );
        expect(first.items.length).toBe(2);
        expect(first.hasMore).toBe(true);
        const second = parseBody(
          auditEntriesPageSchema,
          await (await owner.get(`/api/audit-entries?limit=2&cursor=${first.nextCursor}`)).json(),
        );
        const firstIds = first.items.map((entry) => entry.id);
        const secondIds = second.items.map((entry) => entry.id);
        expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
      });
    });
  });

  describe('audit trail (write side, through the API)', () => {
    it('a patient creation surfaces exactly one create entry for that patient', async () => {
      await ledgerProbe(AREA, async () => {
        const res = await owner.post('/api/patients', {
          ...validPatient,
          firstName: 'Audit',
          lastName: 'Probe',
        });
        expect(res.status).toBe(201);
        const patient = parseBody(patientSchema, await res.json());

        const page = parseBody(
          auditEntriesPageSchema,
          await (await owner.get('/api/audit-entries?limit=100')).json(),
        );
        const entries = page.items.filter(
          (entry) => entry.entity === 'patient' && entry.entityId === patient.id,
        );
        expect(entries).toHaveLength(1);
        const entry = entries[0]!;
        expect(entry.actorEmail).toBe(owner.email);
        expect(entry.action).toBe('create');
        expect(entry.before).toBeNull();
        expect((entry.after as Record<string, unknown> | null)?.['firstName']).toBe('Audit');
      });
    });
  });
});
