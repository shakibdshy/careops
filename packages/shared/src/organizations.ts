import { z } from 'zod';

export const orgRoleSchema = z.enum(['owner', 'admin', 'member']);
export type OrgRole = z.infer<typeof orgRoleSchema>;

/**
 * The roles permitted to mutate care data — the rule behind every @Roles guard
 * on the API and every create/edit/manage affordance on the web. Defined once
 * so a new role (or a rule carve-out) is a one-line change on both sides of the
 * security boundary.
 */
export const MANAGER_ROLES: readonly OrgRole[] = ['admin', 'owner'];

/** Whether the given role may mutate care data (the MANAGER_ROLES rule). */
export function canManage(role: OrgRole): boolean {
  return MANAGER_ROLES.includes(role);
}

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
