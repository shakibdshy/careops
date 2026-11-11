import { createZodDto } from 'nestjs-zod';
import { errorResponseSchema } from '@careops/shared';

/** Swagger shape for every 4xx/5xx response (the shared error taxonomy). */
export class ErrorResponseDto extends createZodDto(errorResponseSchema) {}
