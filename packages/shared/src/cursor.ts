import { z } from 'zod';

/**
 * Cursor-paginated list envelope (ADR-0008): every list endpoint returns
 * this shape. nextCursor is the last item's cursor — undefined means no
 * more pages. Items are typed per endpoint via the item schema parameter.
 */
export function cursorPage<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().optional(),
    hasMore: z.boolean(),
  });
}
export type CursorPage<T> = {
  items: T[];
  nextCursor?: string | undefined;
  hasMore: boolean;
};
