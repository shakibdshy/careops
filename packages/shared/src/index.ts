import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string(),
  mongo: z.enum(['up', 'down']),
  redis: z.enum(['up', 'down']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from './errors.js';
