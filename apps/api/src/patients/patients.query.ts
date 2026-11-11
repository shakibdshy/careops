import { z } from 'zod';

/**
 * List-query contract (ADR-0002): validated at the boundary so a malformed
 * cursor or limit is a 400 with field errors, never a Mongoose CastError 500.
 * A cursor is an ObjectId hex string; the repository's _id range scan only
 * ever receives well-formed values.
 */
export const patientsListQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'must be a valid page cursor')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PatientsListQuery = z.infer<typeof patientsListQuerySchema>;
