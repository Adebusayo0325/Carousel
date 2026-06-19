/**
 * Typed error taxonomy.
 *
 * Every fallible subsystem returns an `AppError` with a stable, machine-readable
 * `code`. This lets the API map errors to HTTP status codes, lets the worker
 * decide retriable vs. terminal failures, and keeps human-facing messages free
 * of sensitive data (audit requirement: "no sensitive data in logs").
 */

export type ErrorCategory =
  | 'validation' // bad input — never retry
  | 'auth' // unauthenticated / unauthorized / expired key
  | 'forbidden' // authenticated but tier/feature not permitted
  | 'not_found'
  | 'conflict' // idempotency / duplicate / state conflict
  | 'rate_limited'
  | 'upstream' // RPC / explorer / marketplace failure — often retriable
  | 'insufficient_funds'
  | 'simulation_failed' // pre-flight sim says the tx would revert
  | 'risk_blocked' // risk engine vetoed the action
  | 'crypto' // encryption / signing failure
  | 'internal';

const RETRIABLE: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'upstream',
  'rate_limited',
]);

export interface AppErrorOptions {
  /** Structured, non-sensitive context safe to log and (sometimes) return. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Original cause, retained for server-side logs only — never serialized to clients. */
  readonly cause?: unknown;
  /** Override the category's default retriability. */
  readonly retriable?: boolean;
}

export class AppError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly details: Readonly<Record<string, unknown>>;
  override readonly cause: unknown;
  readonly retriable: boolean;

  constructor(
    category: ErrorCategory,
    code: string,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.category = category;
    this.code = code;
    this.details = options.details ?? {};
    this.cause = options.cause;
    this.retriable = options.retriable ?? RETRIABLE.has(category);
  }

  /** HTTP status mapping for the API layer. */
  get httpStatus(): number {
    switch (this.category) {
      case 'validation':
        return 400;
      case 'auth':
        return 401;
      case 'forbidden':
      case 'risk_blocked':
        return 403;
      case 'not_found':
        return 404;
      case 'conflict':
        return 409;
      case 'rate_limited':
        return 429;
      case 'insufficient_funds':
      case 'simulation_failed':
        return 422;
      case 'upstream':
        return 502;
      case 'crypto':
      case 'internal':
        return 500;
    }
  }

  /** Client-safe JSON. Deliberately omits `cause` and stack. */
  toClientJSON(): { code: string; category: ErrorCategory; message: string; details: Record<string, unknown> } {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      details: this.details as Record<string, unknown>,
    };
  }
}

// ── Convenience constructors for the common cases ──

export const Errors = {
  validation: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError('validation', code, message, details ? { details } : {}),
  auth: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError('auth', code, message, details ? { details } : {}),
  forbidden: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError('forbidden', code, message, details ? { details } : {}),
  notFound: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError('not_found', code, message, details ? { details } : {}),
  conflict: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError('conflict', code, message, details ? { details } : {}),
  rateLimited: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError('rate_limited', code, message, details ? { details } : {}),
  upstream: (code: string, message: string, options?: AppErrorOptions) =>
    new AppError('upstream', code, message, options ?? {}),
  insufficientFunds: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError('insufficient_funds', code, message, details ? { details } : {}),
  simulationFailed: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError('simulation_failed', code, message, details ? { details } : {}),
  riskBlocked: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError('risk_blocked', code, message, details ? { details } : {}),
  crypto: (code: string, message: string, options?: AppErrorOptions) =>
    new AppError('crypto', code, message, options ?? {}),
  internal: (code: string, message: string, options?: AppErrorOptions) =>
    new AppError('internal', code, message, options ?? {}),
} as const;

/** Coerce an unknown thrown value into an AppError without losing information. */
export function toAppError(cause: unknown): AppError {
  if (cause instanceof AppError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AppError('internal', 'UNEXPECTED', message, { cause });
}
