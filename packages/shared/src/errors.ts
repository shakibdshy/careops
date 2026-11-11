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
