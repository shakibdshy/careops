import { z } from 'zod';

export const fieldErrorSchema = z.object({
  field: z.string(),
  message: z.string(),
});
export type FieldError = z.infer<typeof fieldErrorSchema>;

/** Every API error response, in every failure mode, uses this shape. */
export const errorResponseSchema = z.object({
  statusCode: z.number().int(),
  message: z.string(),
  errors: z.array(fieldErrorSchema),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

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
