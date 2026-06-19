/**
 * argon2id hashing of the access-key secret.
 *
 * Audit requirement: "hashed (argon2) in DB". We use argon2id (hybrid, resistant
 * to both GPU and side-channel attacks) via hash-wasm — a pure-WASM
 * implementation, so there is no native build step and installs are reliable in
 * CI/Docker. The encoded hash string embeds the salt and parameters, so
 * verification is self-describing and parameters can be upgraded over time.
 */

import { argon2id, argon2Verify } from 'hash-wasm';
import { randomBytes } from 'node:crypto';
import { Errors, type AppError } from '@apexmint/core';
import { err, ok, fromPromise, type Result } from '@apexmint/core';

export interface Argon2Params {
  /** Iterations (time cost). */
  readonly timeCost: number;
  /** Memory in KiB. */
  readonly memoryCost: number;
  readonly parallelism: number;
}

/** OWASP-aligned defaults for argon2id (2024): 19 MiB, t=2, p=1. */
export function defaultArgon2Params(): Argon2Params {
  return { timeCost: 2, memoryCost: 19 * 1024, parallelism: 1 };
}

/** Produce an encoded argon2id hash string (PHC format) for a secret. */
export async function hashSecret(
  secret: string,
  params: Argon2Params = defaultArgon2Params(),
): Promise<Result<string, AppError>> {
  return fromPromise(
    argon2id({
      password: secret,
      salt: randomBytes(16),
      iterations: params.timeCost,
      memorySize: params.memoryCost,
      parallelism: params.parallelism,
      hashLength: 32,
      outputType: 'encoded',
    }),
    (cause) => Errors.crypto('ARGON2_HASH_FAILED', 'Failed to hash access key', { cause }),
  );
}

/**
 * Verify a secret against a stored encoded hash. Returns ok(false) for a
 * mismatch (NOT an error) so the caller distinguishes "wrong key" from "hashing
 * subsystem broke".
 */
export async function verifySecret(
  secret: string,
  encodedHash: string,
): Promise<Result<boolean, AppError>> {
  const r = await fromPromise(
    argon2Verify({ password: secret, hash: encodedHash }),
    (cause) => Errors.crypto('ARGON2_VERIFY_FAILED', 'Failed to verify access key', { cause }),
  );
  if (!r.ok) return r;
  return ok(r.value);
}

export { err };
