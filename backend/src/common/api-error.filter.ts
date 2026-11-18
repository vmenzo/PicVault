import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Global error envelope: every error response is
 * `{ code, message }` with the HTTP status preserved. Success shapes are
 * unchanged. Validation failures (Nest ValidationPipe) arrive as a
 * string[] message; they are joined into a single message string and
 * reported with code `validation_error`.
 */
const CODE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'bad_request',
  [HttpStatus.UNAUTHORIZED]: 'unauthorized',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'validation_error',
  [HttpStatus.TOO_MANY_REQUESTS]: 'rate_limited',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'internal_error',
};

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string;
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const raw = (body as { message?: unknown }).message;
        message = Array.isArray(raw)
          ? raw.map(String).join('; ')
          : typeof raw === 'string'
            ? raw
            : exception.message;
      } else {
        message = exception.message;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    } else {
      message = 'Internal server error';
    }

    // Never leak internals for unexpected errors.
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} failed: ${
          exception instanceof Error ? exception.stack ?? exception.message : String(exception)
        }`,
      );
      message = 'Internal server error';
    }

    const isValidationError =
      status === HttpStatus.BAD_REQUEST &&
      exception instanceof HttpException &&
      Array.isArray(
        (exception.getResponse() as { message?: unknown } | null)?.message,
      );
    const code = isValidationError
      ? 'validation_error'
      : (CODE_BY_STATUS[status] ?? 'error');

    response.status(status).json({ code, message });
  }
}
