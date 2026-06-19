import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateToken, parseToken, verifySignature } from '../src/format.js';
import { isErr, isOk } from '@apexmint/core';

const SIGNING = randomBytes(32);

test('generated token parses and verifies', () => {
  const g = generateToken(SIGNING);
  assert.ok(g.token.startsWith('apx_'));
  const parsed = parseToken(g.token);
  assert.ok(isOk(parsed));
  if (!isOk(parsed)) return;
  assert.equal(parsed.value.keyId, g.keyId);
  assert.equal(verifySignature(SIGNING, parsed.value), true);
});

test('signature fails under a different signing secret', () => {
  const g = generateToken(SIGNING);
  const parsed = parseToken(g.token);
  assert.ok(isOk(parsed));
  if (!isOk(parsed)) return;
  assert.equal(verifySignature(randomBytes(32), parsed.value), false);
});

test('tampered secret invalidates signature', () => {
  const g = generateToken(SIGNING);
  const parts = g.token.split('_');
  parts[2] = parts[2]!.slice(0, -1) + (parts[2]!.endsWith('a') ? 'b' : 'a');
  const parsed = parseToken(parts.join('_'));
  assert.ok(isOk(parsed));
  if (!isOk(parsed)) return;
  assert.equal(verifySignature(SIGNING, parsed.value), false);
});

test('malformed tokens are rejected structurally', () => {
  assert.ok(isErr(parseToken('not-a-token')));
  assert.ok(isErr(parseToken('apx_only_three')));
  assert.ok(isErr(parseToken('xxx_a_b_c'))); // wrong prefix
  assert.ok(isErr(parseToken('apx_AAA_b_c'))); // uppercase not in base32 set
});

test('keyId and secret have meaningful entropy / length', () => {
  const g = generateToken(SIGNING);
  // 16 bytes -> ~26 base32 chars; 32 bytes -> ~52.
  assert.ok(g.keyId.length >= 24);
  assert.ok(g.secret.length >= 50);
  // Two generations never collide.
  assert.notEqual(g.keyId, generateToken(SIGNING).keyId);
});
