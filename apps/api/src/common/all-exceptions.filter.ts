import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ErrorResponse, FieldError } from '@careops/shared';
import { ZodError } from 'zod';
import type { Response } from 'express';

/**
 * Maps every failure to the shared error taxonomy (ErrorResponse): a stable
 * { statusCode, message, errors[] } shape the web app can rely on. Stack
 * traces never leave the server.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    const mapped = this.mapException(exception);
    if (mapped.logLevel === 'error') {
      this.logger.error(mapped.logMessage);
    } else {
      this.logger.warn(mapped.logMessage);
    }

    res.status(mapped.statusCode).json(mapped.body satisfies ErrorResponse);
  }

  private mapException(exception: unknown): {
    statusCode: number;
    body: ErrorResponse;
    logLevel: 'warn' | 'error';
    logMessage: string;
  } {
    if (exception instanceof ZodError) {
      const errors: FieldError[] = exception.issues.map((issue) => ({
        field: issue.path.join('.') || 'unknown',
        message: issue.message,
      }));
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        body: { statusCode: HttpStatus.BAD_REQUEST, message: 'Validation failed', errors },
        logLevel: 'warn',
        logMessage: `Validation failed: ${exception.message}`,
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();
      const payloadMessage =
        typeof payload === 'object' && payload !== null && 'message' in payload
          ? payload.message
          : undefined;
      const detailErrors = Array.isArray(payloadMessage)
        ? payloadMessage
            .filter((m): m is string => typeof m === 'string')
            .map((m) => ({ field: 'unknown', message: m }))
        : [];
      const message = typeof payloadMessage === 'string' ? payloadMessage : exception.message;
      return {
        statusCode,
        body: { statusCode, message, errors: detailErrors },
        logLevel: statusCode >= 500 ? 'error' : 'warn',
        logMessage: `HttpException ${statusCode}: ${message}`,
      };
    }

    const detail = exception instanceof Error ? exception.message : String(exception);
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
        errors: [],
      },
      logLevel: 'error',
      logMessage: `Unhandled exception: ${detail}`,
    };
  }
}
