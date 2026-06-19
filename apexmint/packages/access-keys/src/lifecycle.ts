/**
 * Access-key lifecycle, issuance, and verification.
 *
 * Requirements addressed:
 *   • "expire exactly 30 days after activation" — expiry is computed from
 *     `activatedAt`, not issuance. A key sits in `issued` until first use.
 *   • "Tier-based feature gating ... enforced server-side" — the verified
 *     principal carries the resolved, tier-bounded feature set.
 *   • "revoke keys" — a `revokedAt` timestamp terminates a key immediately.
 *
 * Time is injected via a `now` epoch-ms argument everywhere — no hidden clock —
 * so expiry/activation logic is fully deterministic and unit-testable.
 */

import {
  type Tier,
  type Feature,
  isTier,
  resolveGrantedFeatures,
  Errors,
  err,
  ok,
  type AppError,
  type Result,
} from '@apexmint/core';
import { generateToken, parseToken, verifySignature, type GeneratedToken } from './format.js';
import { hashSecret, verifySecret, type Argon2Params } from './hashing.js';

export type KeyStatus = 'issued' | 'active' | 'expired' | 'revoked';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Persisted record (what the DB stores). Contains NO recoverable secret. */
export interface AccessKeyRecord {
  readonly keyId: string;
  /** argon2id-encoded hash of the secret. */
  readonly secretHash: string;
  readonly tier: Tier;
  /** Issued feature spec; may include the "all" shorthand. */
  readonly features: readonly string[];
  /** Lifetime once activated. */
  readonly durationMs: number;
  readonly createdAt: number;
  /** Set on first successful verification; null until then. */
  readonly activatedAt: number | null;
  readonly revokedAt: number | null;
  /** Owner user id, set when the key is bound to an account. */
  readonly userId: string | null;
}

export interface IssueKeyInput {
  readonly tier: Tier;
  readonly features: readonly string[];
  readonly durationMs: number;
  readonly now: number;
  readonly argon2Params?: Argon2Params;
  readonly signingSecret: Buffer;
}

export interface IssuedKey {
  /** The one-time token to hand to the user. */
  readonly token: string;
  /** The record to persist (no recoverable secret inside). */
  readonly record: AccessKeyRecord;
}

/** Admin issues a new key: generate token, hash secret, build the record. */
export async function issueKey(input: IssueKeyInput): Promise<Result<IssuedKey, AppError>> {
  if (!isTier(input.tier)) {
    return err(Errors.validation('BAD_TIER', `Unknown tier "${input.tier}"`));
  }
  if (!Number.isInteger(input.durationMs) || input.durationMs <= 0) {
    return err(Errors.validation('BAD_DURATION', 'Duration must be a positive integer (ms)'));
  }
  const generated: GeneratedToken = generateToken(input.signingSecret);
  const hashed = await hashSecret(generated.secret, input.argon2Params);
  if (!hashed.ok) return hashed;

  const record: AccessKeyRecord = {
    keyId: generated.keyId,
    secretHash: hashed.value,
    tier: input.tier,
    features: [...input.features],
    durationMs: input.durationMs,
    createdAt: input.now,
    activatedAt: null,
    revokedAt: null,
    userId: null,
  };
  return ok({ token: generated.token, record });
}

/** Pure status computation from a record at a given instant. */
export function statusOf(record: AccessKeyRecord, now: number): KeyStatus {
  if (record.revokedAt !== null) return 'revoked';
  if (record.activatedAt === null) return 'issued';
  if (now >= record.activatedAt + record.durationMs) return 'expired';
  return 'active';
}

export function expiresAt(record: AccessKeyRecord): number | null {
  return record.activatedAt === null ? null : record.activatedAt + record.durationMs;
}

/** The authenticated principal handed to the API after a successful verify. */
export interface Principal {
  readonly keyId: string;
  readonly userId: string | null;
  readonly tier: Tier;
  /** Concrete, tier-bounded grants (the "all" shorthand already resolved). */
  readonly features: readonly Feature[];
  readonly expiresAt: number;
}

export interface VerifyDeps {
  /** Locate a key record by its public id. Returns null if absent. */
  readonly lookup: (keyId: string) => Promise<AccessKeyRecord | null>;
  /**
   * Persist the activation timestamp on first use. Must be idempotent — only the
   * first caller sets it. Returns the (possibly already-activated) record.
   */
  readonly activate: (keyId: string, now: number) => Promise<AccessKeyRecord>;
  readonly signingSecret: Buffer;
  readonly now: number;
}

/**
 * Verify a presented token end-to-end:
 *   1. structural parse        (cheap)
 *   2. HMAC signature check    (cheap — rejects forgeries before argon2)
 *   3. record lookup
 *   4. status gate             (revoked / expired)
 *   5. argon2id secret verify  (expensive — only reached by well-formed tokens)
 *   6. activate-on-first-use   (starts the 30-day clock)
 */
export async function verifyToken(token: string, deps: VerifyDeps): Promise<Result<Principal, AppError>> {
  const parsed = parseToken(token);
  if (!parsed.ok) return parsed;

  if (!verifySignature(deps.signingSecret, parsed.value)) {
    return err(Errors.auth('BAD_SIGNATURE', 'Access key signature invalid'));
  }

  const record = await deps.lookup(parsed.value.keyId);
  if (!record) {
    return err(Errors.auth('UNKNOWN_KEY', 'Access key not recognized'));
  }

  // Gate on status BEFORE the costly hash check where possible.
  const preStatus = statusOf(record, deps.now);
  if (preStatus === 'revoked') {
    return err(Errors.auth('KEY_REVOKED', 'Access key has been revoked'));
  }
  if (preStatus === 'expired') {
    return err(Errors.auth('KEY_EXPIRED', 'Access key has expired'));
  }

  const secretOk = await verifySecret(parsed.value.secret, record.secretHash);
  if (!secretOk.ok) return secretOk;
  if (!secretOk.value) {
    return err(Errors.auth('BAD_SECRET', 'Access key secret invalid'));
  }

  // Activate on first successful verification (idempotent in the store).
  let effective = record;
  if (record.activatedAt === null) {
    effective = await deps.activate(record.keyId, deps.now);
  }

  // Re-check expiry against the effective activation (covers the just-activated
  // edge and any clock movement during await).
  const status = statusOf(effective, deps.now);
  if (status === 'expired') {
    return err(Errors.auth('KEY_EXPIRED', 'Access key has expired'));
  }
  if (status === 'revoked') {
    return err(Errors.auth('KEY_REVOKED', 'Access key has been revoked'));
  }

  const exp = expiresAt(effective);
  if (exp === null) {
    return err(Errors.internal('ACTIVATION_FAILED', 'Key activation did not persist'));
  }

  return ok({
    keyId: effective.keyId,
    userId: effective.userId,
    tier: effective.tier,
    features: resolveGrantedFeatures(effective.tier, effective.features),
    expiresAt: exp,
  });
}

/** Parse a human duration like "30d", "12h", "90m" into milliseconds. */
export function parseDuration(spec: string): Result<number, AppError> {
  const m = /^(\d+)\s*(d|h|m|s)$/.exec(spec.trim());
  if (!m) {
    return err(Errors.validation('BAD_DURATION_SPEC', 'Use forms like "30d", "12h", "45m", "30s"'));
  }
  const n = Number(m[1]);
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: MS_PER_DAY }[m[2] as 's' | 'm' | 'h' | 'd'];
  return ok(n * unitMs);
}
