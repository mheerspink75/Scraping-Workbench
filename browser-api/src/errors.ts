import type { ErrorBody } from './contracts.js';

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return new AppError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
}

export function errorBody(error: AppError, requestId?: string): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(requestId ? { requestId } : {}),
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}
