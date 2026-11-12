import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string(),
  mongo: z.enum(['up', 'down']),
  redis: z.enum(['up', 'down']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from './appointments.js';
export * from './appointment-status.js';
export * from './cursor.js';
export * from './errors.js';
export * from './organizations.js';
export * from './patients.js';
export * from './reports.js';
export * from './workspace.js';
