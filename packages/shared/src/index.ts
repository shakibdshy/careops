import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string(),
  // Which backend serves the response (Go-T10): 'nestjs' on the reference,
  // 'go' on the replica. Optional so older artifacts stay parseable; both
  // backends always send it.
  implementation: z.string().optional(),
  // Dependency keys are implementation-specific (the stated parity
  // exception): the reference reports mongo/redis, the replica reports
  // postgres. Known keys are declared for typing; consumers must not
  // require a fixed set.
  mongo: z.enum(['up', 'down']).optional(),
  redis: z.enum(['up', 'down']).optional(),
  postgres: z.enum(['up', 'down']).optional(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from './appointments.js';
export * from './appointment-status.js';
export * from './cursor.js';
export * from './errors.js';
export * from './notifications.js';
export * from './organizations.js';
export * from './pagination.js';
export * from './patients.js';
export * from './reports.js';
export * from './workspace.js';
