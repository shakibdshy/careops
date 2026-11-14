import { z } from 'zod';

/**
 * Pagination request contract (ADR-0008) — the query-side twin of cursorPage().
 * A cursor is a MongoDB ObjectId hex string; limit is clamped to 1..MAX_PAGE_LIMIT
 * with a DEFAULT_PAGE_LIMIT default. Single source for every paginated list
 * endpoint (ADR-0002 covers queries as well as bodies): API controllers validate
 * with this schema, and services on both apps import the same defaults, so the
 * page-size policy has exactly one definition.
 */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export const cursorPageQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, 'must be a valid page cursor')
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

export type CursorPageQuery = z.infer<typeof cursorPageQuerySchema>;
