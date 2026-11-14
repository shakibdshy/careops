import { z } from 'zod';
import { orgRoleSchema } from './organizations.js';

/** Workspace context: who is signed in and which Organization they act in. */
export const workspaceMeSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  organization: z.object({
    id: z.string(),
    name: z.string(),
    // The role vocabulary is the shared org enum — never re-declared here.
    role: orgRoleSchema,
  }),
});
export type WorkspaceMe = z.infer<typeof workspaceMeSchema>;
