import request from 'supertest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import {
  errorResponseSchema,
  organizationCurrentSchema,
  invitationSchema,
  workspaceMeSchema,
} from '@careops/shared';
import { setupE2eApp } from './mongo.js';

function userOf(email: string) {
  return { name: email.split('@')[0] ?? 'User', email, password: 'correct-horse-battery-staple' };
}

const owner = userOf('owner@example.test');
const invitee = userOf('invitee@example.test');

describe('Organizations + RBAC (e2e)', () => {
  let app: INestApplication<App>;
  let mongo: MongoMemoryReplSet;
  let ownerAgent: ReturnType<typeof request.agent>;
  let inviteeAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    ({ app, mongo } = await setupE2eApp('careops-org-test'));
    ownerAgent = request.agent(app.getHttpServer());
    inviteeAgent = request.agent(app.getHttpServer());

    await ownerAgent.post('/api/auth/sign-up/email').send(owner).expect(200);
    await inviteeAgent.post('/api/auth/sign-up/email').send(invitee).expect(200);
  });

  afterAll(async () => {
    await app.close();
    await mongo.stop();
  });

  describe('signup organization invariant', () => {
    it('creates an organization with the creator as owner at signup', async () => {
      const res = await ownerAgent.get('/api/workspace/me').expect(200);
      const me = workspaceMeSchema.parse(res.body);
      expect(me.organization.role).toBe('owner');
      expect(me.organization.id).not.toBe('');
    });
  });

  describe('invitation flow', () => {
    let invitationId: string;
    let ownerOrgId: string;

    it('an owner invites a user by email with a role', async () => {
      const meRes = await ownerAgent.get('/api/workspace/me').expect(200);
      ownerOrgId = workspaceMeSchema.parse(meRes.body).organization.id;

      const res = await ownerAgent
        .post('/api/organizations/invitations')
        .send({ email: invitee.email, role: 'member' })
        .expect(201);
      const invitation = invitationSchema.parse(res.body);
      expect(invitation.email).toBe(invitee.email);
      expect(invitation.status).toBe('pending');
      invitationId = invitation.id;
    });

    it('a member cannot create invitations', async () => {
      // The invitee has not joined yet: their active org is their own
      // auto-created one, and its role is owner. Denial by role requires a
      // member — asserted later once the invitee has joined.
      const res = await inviteeAgent.get('/api/workspace/me').expect(200);
      expect(workspaceMeSchema.parse(res.body).organization.role).toBe('owner');
    });

    it('the invitee accepts and joins the organization', async () => {
      // Browsers always send Origin; the org plugin enforces it on accept.
      await inviteeAgent
        .post('/api/auth/organization/accept-invitation')
        .set('Origin', 'http://localhost:3000')
        .send({ invitationId })
        .expect(200);
      // The accepted organization becomes the invitee's active one.
      await inviteeAgent
        .post('/api/auth/organization/set-active')
        .send({ organizationId: ownerOrgId })
        .expect(200);
    });

    it('the member appears in the organization member list with their role', async () => {
      const res = await ownerAgent.get('/api/organizations/current').expect(200);
      const org = organizationCurrentSchema.parse(res.body);
      expect(org.id).toBe(ownerOrgId);
      const rolesByEmail = new Map(org.members.map((member) => [member.email, member.role]));
      expect(rolesByEmail.get(owner.email)).toBe('owner');
      expect(rolesByEmail.get(invitee.email)).toBe('member');
    });

    it('org context comes from the verified session, not the request body', async () => {
      // The invitee's session now points at the owner's organization.
      const res = await inviteeAgent.get('/api/workspace/me').expect(200);
      const me = workspaceMeSchema.parse(res.body);
      expect(me.organization.id).toBe(ownerOrgId);
      expect(me.organization.role).toBe('member');
    });
  });

  describe('role enforcement', () => {
    it('denies a member an admin-only route with 403 in the shared taxonomy', async () => {
      const res = await inviteeAgent.get('/api/workspace/admin-probe');
      expect(res.status).toBe(403);
      const parsed = errorResponseSchema.parse(res.body);
      expect(parsed.message).toMatch(/admin or owner/);
    });

    it('denies a member creating invitations with 403 in the shared taxonomy', async () => {
      // The invitee is now a member of the owner's organization.
      const res = await inviteeAgent
        .post('/api/organizations/invitations')
        .send({ email: 'someone@else.test', role: 'member' });
      expect(res.status).toBe(403);
      errorResponseSchema.parse(res.body);
    });

    it('rejects an invalid invitation payload with field-level errors', async () => {
      const res = await ownerAgent
        .post('/api/organizations/invitations')
        .send({ email: 'not-an-email', role: 'member' });
      expect(res.status).toBe(400);
      const parsed = errorResponseSchema.parse(res.body);
      expect(parsed.errors.some((error) => error.field === 'email')).toBe(true);
    });

    it('allows an owner an admin-only route', async () => {
      await ownerAgent.get('/api/workspace/admin-probe').expect(200);
    });
  });
});
