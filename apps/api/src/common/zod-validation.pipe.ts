import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { FieldError } from '@careops/shared';
import type { ZodType } from 'zod';

/**
 * Validates a request body against a shared Zod schema at the boundary
 * (ADR-0002): the same schema that types the client drives server-side
 * validation, so the contract has exactly one definition. Failures map into
 * the shared error taxonomy with field-level entries.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
    const errors: FieldError[] = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'unknown',
      message: issue.message,
    }));
    throw new BadRequestException({ message: 'Validation failed', errors });
  }
}
