/**
 * Result<T, E> — explicit success/failure as a value.
 *
 * Rationale (audit fix): the legacy Hermès bot suffered from silent/unhandled
 * promise rejections that produced "ghost schedules" and fake success messages.
 * By modelling fallible operations as `Result` values rather than thrown
 * exceptions, the type system forces every caller to acknowledge the failure
 * path. A function returning `Result` cannot be accidentally treated as
 * always-successful.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

/** Map the success value; pass the error through untouched. */
export function map<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

/** Map the error value; pass the success through untouched. */
export function mapErr<T, E, F>(r: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return r.ok ? r : err(fn(r.error));
}

/** Chain a fallible operation onto a success. */
export function andThen<T, U, E>(
  r: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return r.ok ? fn(r.value) : r;
}

/** Extract the value or fall back to a default. */
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/**
 * Run a throwing async function and capture any rejection as an `Err`.
 * This is the *single* sanctioned boundary where we convert exceptions into
 * Results — nothing past this point silently rejects.
 */
export async function fromPromise<T, E>(
  promise: Promise<T>,
  onError: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await promise);
  } catch (cause) {
    return err(onError(cause));
  }
}

/** Synchronous twin of {@link fromPromise}. */
export function fromThrowable<T, E>(
  fn: () => T,
  onError: (cause: unknown) => E,
): Result<T, E> {
  try {
    return ok(fn());
  } catch (cause) {
    return err(onError(cause));
  }
}
