/**
 * Key derivation for the user-controlled encryption layer.
 *
 * This is the layer that locks the operator/admin OUT. The server stores only
 * the salt and KDF params — never the passphrase nor the derived key. Without
 * the user's passphrase, the inner ciphertext is undecryptable even by someone
 * holding the database AND the KMS root key.
 *
 * We use scrypt (memory-hard, in Node core) so brute-forcing a stolen salt is
 * expensive. argon2id would be marginally preferable but is not in Node core;
 * scrypt with these parameters is a defensible choice and keeps the dependency
 * surface (and therefore the audit surface) minimal.
 */

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { Errors, type AppError } from '@apexmint/core';
import { err, ok, type Result } from '@apexmint/core';
import { AES_KEY_BYTES } from './secretbox.js';

export interface KdfParams {
  /** scrypt cost (N): CPU/memory work factor. Power of two. */
  readonly N: number;
  readonly r: number;
  readonly p: number;
  /** Random salt, hex. */
  readonly salt: string;
}

/** Sensible interactive defaults: ~64MB, fast enough for login, hard to brute. */
export function defaultKdfParams(): KdfParams {
  return { N: 1 << 15, r: 8, p: 1, salt: randomBytes(16).toString('hex') };
}

export function deriveKey(passphrase: string, params: KdfParams): Promise<Result<Buffer, AppError>> {
  return new Promise((resolve) => {
    let salt: Buffer;
    try {
      salt = Buffer.from(params.salt, 'hex');
    } catch {
      resolve(err(Errors.crypto('BAD_SALT', 'Salt is not valid hex')));
      return;
    }
    if (salt.length < 8) {
      resolve(err(Errors.crypto('BAD_SALT', 'Salt too short')));
      return;
    }
    // maxmem must accommodate N*r*128 bytes plus headroom.
    const maxmem = 256 * params.N * params.r;
    scrypt(
      passphrase.normalize('NFKC'),
      salt,
      AES_KEY_BYTES,
      { N: params.N, r: params.r, p: params.p, maxmem },
      (e, derived) => {
        if (e) {
          resolve(err(Errors.crypto('KDF_FAILED', 'Key derivation failed', { cause: e })));
          return;
        }
        resolve(ok(derived));
      },
    );
  });
}

/** Verify a passphrase derives to a previously stored key check value. */
export async function verifyPassphrase(
  passphrase: string,
  params: KdfParams,
  expectedKey: Buffer,
): Promise<Result<boolean, AppError>> {
  const derived = await deriveKey(passphrase, params);
  if (!derived.ok) return derived;
  const equal =
    derived.value.length === expectedKey.length &&
    timingSafeEqual(derived.value, expectedKey);
  return ok(equal);
}
