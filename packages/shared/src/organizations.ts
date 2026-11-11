import { z } from 'zod';

export const orgRoleSchema = z.enum(['owner', 'admin', 'member']);
export type OrgRole = z.infer<typeof orgRoleSchema>;

export const organizationMemberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: orgRoleSchema,
});
export type OrganizationMember = z.infer<typeof organizationMemberSchema>;

/** The active organization with its members (RBAC surface, ADR-0006). */
export const organizationCurrentSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  members: z.array(organizationMemberSchema),
});
export type OrganizationCurrent = z.infer<typeof organizationCurrentSchema>;

export const createInvitationSchema = z.object({
  email: z.string().email(),
  role: orgRoleSchema,
});
export type CreateInvitationDto = z.infer<typeof createInvitationSchema>;

export const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  status: z.string(),
  organizationId: z.string(),
});
export type Invitation = z.infer<typeof invitationSchema>;
