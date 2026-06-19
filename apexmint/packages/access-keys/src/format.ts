/**
 * Access-key token format & signing.
 *
 * Token (shown to user once, never stored):
 *
 *     apx_<keyId>_<secret>_<sig>
 *
 *   keyId  : 16 random bytes, base32 — PUBLIC. Stored plaintext + indexed so we
 *            can locate the record without scanning argon2 hashes.
 *   secret : 32 random bytes, base32 — PRIVATE. Only argon2id(secret) is stored.
 *   sig    : HMAC-SHA256(signingSecret, "<keyId>.<secret>"), base32, truncated.
 *
 * Why the HMAC signature (audit: "cryptographically signed"):
 *   • Forged/corrupted tokens are rejected in microseconds via the HMAC check,
 *     BEFORE the deliberately-expensive argon2id verify runs. This both gives a
 *     fast negative path and prevents argon2 CPU-exhaustion DoS from random
 *     tokens.
 *   • The signing secret is admin-held; only the admin can mint valid tokens.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Errors, type AppError } from '@apexmint/core';
import { err, ok, type Result } from '@apexmint/core';

const PREFIX = 'apx';
const KEY_ID_BYTES = 16;
const SECRET_BYTES = 32;
const SIG_BYTES = 16; // 128-bit truncated HMAC tag — ample for an integrity gate

/** RFC4648 base32 (no padding), lowercased, using Crockford-ish safe alphabet. */
const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export interface ParsedToken {
  readonly keyId: string;
  readonly secret: string;
  readonly sig: string;
}

export interface GeneratedToken extends ParsedToken {
  /** The full token string to hand to the user. */
  readonly token: string;
}

function sign(signingSecret: Buffer, keyId: string, secret: string): string {
  const mac = createHmac('sha256', signingSecret).update(`${keyId}.${secret}`).digest();
  return base32Encode(mac.subarray(0, SIG_BYTES));
}

/** Mint a fresh, signed token. The `secret` must be argon2-hashed by the caller. */
export function generateToken(signingSecret: Buffer): GeneratedToken {
  const keyId = base32Encode(randomBytes(KEY_ID_BYTES));
  const secret = base32Encode(randomBytes(SECRET_BYTES));
  const sig = sign(signingSecret, keyId, secret);
  return { keyId, secret, sig, token: `${PREFIX}_${keyId}_${secret}_${sig}` };
}

/** Parse a token's structure without verifying the signature. */
export function parseToken(token: string): Result<ParsedToken, AppError> {
  const parts = token.split('_');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    return err(Errors.auth('BAD_TOKEN_FORMAT', 'Malformed access key'));
  }
  const [, keyId, secret, sig] = parts;
  if (!keyId || !secret || !sig) {
    return err(Errors.auth('BAD_TOKEN_FORMAT', 'Malformed access key'));
  }
  // Cheap charset sanity to keep junk out of downstream lookups.
  const ok32 = (s: string) => /^[a-z2-7]+$/.test(s);
  if (!ok32(keyId) || !ok32(secret) || !ok32(sig)) {
    return err(Errors.auth('BAD_TOKEN_FORMAT', 'Access key contains invalid characters'));
  }
  return ok({ keyId, secret, sig });
}

/**
 * Verify the HMAC signature in constant time. This is the cheap pre-check that
 * runs before the expensive argon2id verification.
 */
export function verifySignature(signingSecret: Buffer, parsed: ParsedToken): boolean {
  const expected = sign(signingSecret, parsed.keyId, parsed.secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(parsed.sig);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
