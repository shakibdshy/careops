import { z } from 'zod';

/** Workspace context: who is signed in and which Organization they act in. */
export const workspaceMeSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  organization: z.object({
    id: z.string(),
    name: z.string(),
    role: z.enum(['owner', 'admin', 'member']),
  }),
});
export type WorkspaceMe = z.infer<typeof workspaceMeSchema>;
