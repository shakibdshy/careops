import { z } from 'zod';

/**
 * Shared cursor/limit query for paginated list endpoints (ADR-0008): a
 * cursor is an ObjectId hex string; limit is clamped to 1..100. Validated at
 * the boundary so malformed input is a 400 with field errors, never a
 * Mongoose CastError 500.
 */
export const cursorPageQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'must be a valid page cursor')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CursorPageQuery = z.infer<typeof cursorPageQuerySchema>;
