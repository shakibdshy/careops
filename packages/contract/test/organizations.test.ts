// Organization + RBAC conformance cases (Go-T04) — ported from the reference
// API's org e2e suite. Same meanings, black-box seam: the signup Organization
// invariant, the invitation flow, session-derived org context, and the
// Manager rule enforced end-to-end — all validated against the shared schemas.
import { beforeAll, describe, expect, it } from 'bun:test';
import { invitationSchema, organizationCurrentSchema, workspaceMeSchema } from '@careops/shared';
import { assertLedgerAllows, expectTaxonomy, parseBody, Session } from './helpers.js';

describe('organizations + RBAC (conformance)', () => {
  const AREA = 'organizations';

  let owner: Session;
  let invitee: Session;
  let ownerOrgId = '';
  let invitationId = '';

  beforeAll(async () => {
    owner = await Session.signUp('Org Owner');
    invitee = await Session.signUp('Org Invitee');
  });

  it('creates an organization with the creator as owner at signup', async () => {
    assertLedgerAllows(AREA);
    const res = await owner.me();
    expect(res.status).toBe(200);
    const me = parseBody(workspaceMeSchema, await res.json());
    expect(me.organization.role).toBe('owner');
    expect(me.organization.id).not.toBe('');
  });

  it('an owner invites a user by email with a role', async () => {
    assertLedgerAllows(AREA);
    const me = parseBody(workspaceMeSchema, await (await owner.me()).json());
    ownerOrgId = me.organization.id;

    const res = await owner.post('/api/organizations/invitations', {
      email: invitee.email,
      role: 'member',
    });
    expect(res.status).toBe(201);
    const invitation = parseBody(invitationSchema, await res.json());
    expect(invitation.email).toBe(invitee.email);
    expect(invitation.status).toBe('pending');
    invitationId = invitation.id;
  });

  it('a member cannot create invitations', async () => {
    // The invitee has not joined yet: their active org is their own
    // auto-created one and their role there is owner — denial by role is
    // asserted later, once the invitee has joined as a member.
    assertLedgerAllows(AREA);
    const res = await invitee.me();
    expect(res.status).toBe(200);
    const me = parseBody(workspaceMeSchema, await res.json());
    expect(me.organization.role).toBe('owner');
  });

  it('the invitee accepts and joins the organization', async () => {
    // Browsers always send Origin; the org plugin enforces it on accept
    // (Session.post sends it the same way).
    assertLedgerAllows(AREA);
    const accept = await invitee.post('/api/auth/organization/accept-invitation', {
      invitationId,
    });
    expect(accept.status).toBe(200);
    // The accepted organization becomes the invitee's active one.
    const setActive = await invitee.post('/api/auth/organization/set-active', {
      organizationId: ownerOrgId,
    });
    expect(setActive.status).toBe(200);
  });

  it('the member appears in the organization member list with their role', async () => {
    assertLedgerAllows(AREA);
    const res = await owner.get('/api/organizations/current');
    expect(res.status).toBe(200);
    const org = parseBody(organizationCurrentSchema, await res.json());
    expect(org.id).toBe(ownerOrgId);
    const rolesByEmail = new Map(org.members.map((member) => [member.email, member.role]));
    expect(rolesByEmail.get(owner.email)).toBe('owner');
    expect(rolesByEmail.get(invitee.email)).toBe('member');
  });

  it('org context comes from the verified session, not the request body', async () => {
    assertLedgerAllows(AREA);
    const res = await invitee.me();
    expect(res.status).toBe(200);
    const me = parseBody(workspaceMeSchema, await res.json());
    expect(me.organization.id).toBe(ownerOrgId);
    expect(me.organization.role).toBe('member');
  });

  it('denies a member an admin-only route with 403 in the shared taxonomy', async () => {
    assertLedgerAllows(AREA);
    const res = await invitee.get('/api/workspace/admin-probe');
    const parsed = await expectTaxonomy(res, 403);
    expect(parsed.message).toMatch(/admin or owner/);
  });

  it('denies a member creating invitations with 403 in the shared taxonomy', async () => {
    assertLedgerAllows(AREA);
    const res = await invitee.post('/api/organizations/invitations', {
      email: 'someone@else.test',
      role: 'member',
    });
    await expectTaxonomy(res, 403);
  });

  it('rejects an invalid invitation payload with field-level errors', async () => {
    assertLedgerAllows(AREA);
    const res = await owner.post('/api/organizations/invitations', {
      email: 'not-an-email',
      role: 'member',
    });
    expect(res.status).toBe(400);
    const parsed = await expectTaxonomy(res, 400);
    expect(parsed.errors.some((error) => error.field === 'email')).toBe(true);
  });

  it('allows an owner an admin-only route', async () => {
    assertLedgerAllows(AREA);
    const res = await owner.get('/api/workspace/admin-probe');
    expect(res.status).toBe(200);
  });
});
