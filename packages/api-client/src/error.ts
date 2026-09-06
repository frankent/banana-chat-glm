import type { ErrorCode } from '@banana-chat/shared';

/** §7 error envelope */
export interface ApiErrorBody {
  error: {
    code: ErrorCode | string;
    message: string;
    details?: { fields?: Record<string, string[]> } & Record<string, unknown>;
    request_id: string | null;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ApiErrorBody['error']['details'];
  readonly requestId: string | null;

  constructor(status: number, body: ApiErrorBody['error']) {
    super(`[${body.code}] ${body.message}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.requestId = body.request_id ?? null;
  }
}

export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super(cause instanceof Error ? cause.message : 'network error');
    this.name = 'NetworkError';
  }
}
