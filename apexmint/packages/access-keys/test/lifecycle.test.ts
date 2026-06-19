import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  issueKey,
  verifyToken,
  statusOf,
  expiresAt,
  parseDuration,
  MS_PER_DAY,
  type AccessKeyRecord,
  type VerifyDeps,
} from '../src/lifecycle.js';
import { isErr, isOk } from '@apexmint/core';

const SIGNING = randomBytes(32);
// Fast argon2 params for tests — production uses defaults.
const FAST = { timeCost: 1, memoryCost: 512, parallelism: 1 };

/** In-memory key store implementing the VerifyDeps seam. */
function makeStore(now: number) {
  const map = new Map<string, AccessKeyRecord>();
  const deps = (atNow: number): VerifyDeps => ({
    signingSecret: SIGNING,
    now: atNow,
    lookup: async (keyId) => map.get(keyId) ?? null,
    activate: async (keyId, t) => {
      const rec = map.get(keyId)!;
      const updated = rec.activatedAt === null ? { ...rec, activatedAt: t } : rec;
      map.set(keyId, updated);
      return updated;
    },
  });
  return { map, deps, now };
}

async function issuePremium(now: number, durationMs = 30 * MS_PER_DAY) {
  const issued = await issueKey({
    tier: 'premium',
    features: ['all'],
    durationMs,
    now,
    argon2Params: FAST,
    signingSecret: SIGNING,
  });
  assert.ok(isOk(issued));
  if (!isOk(issued)) throw new Error('issue');
  return issued.value;
}

test('key is "issued" until first use, then "active"', async () => {
  const t0 = 1_000_000;
  const store = makeStore(t0);
  const { token, record } = await issuePremium(t0);
  store.map.set(record.keyId, record);

  assert.equal(statusOf(record, t0), 'issued');
  assert.equal(expiresAt(record), null);

  const v = await verifyToken(token, store.deps(t0));
  assert.ok(isOk(v));
  if (isOk(v)) {
    assert.equal(v.value.tier, 'premium');
    assert.equal(v.value.expiresAt, t0 + 30 * MS_PER_DAY);
  }
  assert.equal(statusOf(store.map.get(record.keyId)!, t0), 'active');
});

test('expiry is measured from ACTIVATION, not issuance', async () => {
  const issueTime = 1_000_000;
  const store = makeStore(issueTime);
  const { token, record } = await issuePremium(issueTime);
  store.map.set(record.keyId, record);

  // Activate 100 days after issuance — should still work and reset the clock.
  const activateTime = issueTime + 100 * MS_PER_DAY;
  const v = await verifyToken(token, store.deps(activateTime));
  assert.ok(isOk(v));
  if (isOk(v)) assert.equal(v.value.expiresAt, activateTime + 30 * MS_PER_DAY);

  // 29 days after activation: still valid.
  const ok29 = await verifyToken(token, store.deps(activateTime + 29 * MS_PER_DAY));
  assert.ok(isOk(ok29));

  // 31 days after activation: expired.
  const exp = await verifyToken(token, store.deps(activateTime + 31 * MS_PER_DAY));
  assert.ok(isErr(exp));
  if (isErr(exp)) assert.equal(exp.error.code, 'KEY_EXPIRED');
});

test('exactly-30-days boundary expires (>=, not >)', async () => {
  const t0 = 5_000_000;
  const store = makeStore(t0);
  const { token, record } = await issuePremium(t0);
  store.map.set(record.keyId, record);
  await verifyToken(token, store.deps(t0)); // activate at t0

  const atBoundary = t0 + 30 * MS_PER_DAY; // exactly 30 days
  const r = await verifyToken(token, store.deps(atBoundary));
  assert.ok(isErr(r));
  if (isErr(r)) assert.equal(r.error.code, 'KEY_EXPIRED');
});

test('revoked key is rejected', async () => {
  const t0 = 1_000_000;
  const store = makeStore(t0);
  const { token, record } = await issuePremium(t0);
  store.map.set(record.keyId, { ...record, revokedAt: t0 + 5 });

  const r = await verifyToken(token, store.deps(t0 + 10));
  assert.ok(isErr(r));
  if (isErr(r)) assert.equal(r.error.code, 'KEY_REVOKED');
});

test('forged signature rejected before argon2 (fast path)', async () => {
  const t0 = 1_000_000;
  const store = makeStore(t0);
  const { token, record } = await issuePremium(t0);
  store.map.set(record.keyId, record);

  // Corrupt the signature segment.
  const parts = token.split('_');
  parts[3] = parts[3]!.slice(0, -1) + (parts[3]!.endsWith('a') ? 'b' : 'a');
  const r = await verifyToken(parts.join('_'), store.deps(t0));
  assert.ok(isErr(r));
  if (isErr(r)) assert.equal(r.error.code, 'BAD_SIGNATURE');
});

test('wrong secret with valid-looking structure is rejected', async () => {
  const t0 = 1_000_000;
  const store = makeStore(t0);
  const { record } = await issuePremium(t0);
  store.map.set(record.keyId, record);

  // A different validly-signed token for a NON-existent key id.
  const r = await verifyToken('apx_aaaa_bbbb_cccc', store.deps(t0));
  assert.ok(isErr(r)); // bad signature (we didn't sign this)
});

test('unknown key id rejected', async () => {
  const t0 = 1_000_000;
  const store = makeStore(t0);
  // Properly signed token but never stored.
  const issued = await issuePremium(t0);
  const r = await verifyToken(issued.token, store.deps(t0));
  assert.ok(isErr(r));
  if (isErr(r)) assert.equal(r.error.code, 'UNKNOWN_KEY');
});

test('basic-tier key cannot escalate features even if issued "all"', async () => {
  const t0 = 1_000_000;
  const store = makeStore(t0);
  const issued = await issueKey({
    tier: 'basic',
    features: ['all'],
    durationMs: 30 * MS_PER_DAY,
    now: t0,
    argon2Params: FAST,
    signingSecret: SIGNING,
  });
  assert.ok(isOk(issued));
  if (!isOk(issued)) return;
  store.map.set(issued.value.record.keyId, issued.value.record);

  const v = await verifyToken(issued.value.token, store.deps(t0));
  assert.ok(isOk(v));
  if (isOk(v)) {
    // "all" resolves only to what basic grants — no solana/bundles.
    assert.ok(!v.value.features.includes('solana'));
    assert.ok(!v.value.features.includes('bundles'));
    assert.ok(v.value.features.includes('evm-mint'));
  }
});

test('parseDuration handles d/h/m/s and rejects junk', () => {
  const d = parseDuration('30d');
  assert.ok(isOk(d));
  if (isOk(d)) assert.equal(d.value, 30 * MS_PER_DAY);
  assert.ok(isOk(parseDuration('12h')));
  assert.ok(isOk(parseDuration('45m')));
  assert.ok(isErr(parseDuration('30 fortnights')));
  assert.ok(isErr(parseDuration('')));
});

test('issue rejects bad tier and duration', async () => {
  const bad = await issueKey({
    // @ts-expect-error deliberately invalid
    tier: 'platinum',
    features: [],
    durationMs: 1000,
    now: 1,
    signingSecret: SIGNING,
  });
  assert.ok(isErr(bad));

  const badDur = await issueKey({
    tier: 'premium',
    features: [],
    durationMs: -1,
    now: 1,
    signingSecret: SIGNING,
  });
  assert.ok(isErr(badDur));
});
