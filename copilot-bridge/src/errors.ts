export interface BridgeErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

export class BridgeError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function normalizeError(error: unknown, requestId?: string): { status: number; body: BridgeErrorBody } {
  if (error instanceof BridgeError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.code === 'INVALID_ENDPOINT' ? {} : (requestId ? { requestId } : {})),
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'BRIDGE_INTERNAL_ERROR',
        message: 'An unexpected bridge error occurred.',
        ...(requestId ? { requestId } : {}),
      },
    },
  };
}
