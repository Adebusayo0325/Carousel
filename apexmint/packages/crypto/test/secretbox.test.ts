import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { seal, open, wipe, constantTimeEqual, AES_KEY_BYTES } from '../src/secretbox.js';
import { isErr, isOk } from '@apexmint/core';

test('round-trips plaintext', () => {
  const key = randomBytes(AES_KEY_BYTES);
  const msg = Buffer.from('hello vault');
  const sealed = seal(key, msg);
  assert.ok(isOk(sealed));
  if (!isOk(sealed)) return;
  const opened = open(key, sealed.value);
  assert.ok(isOk(opened));
  if (isOk(opened)) assert.equal(opened.value.toString(), 'hello vault');
});

test('rejects wrong key', () => {
  const sealed = seal(randomBytes(AES_KEY_BYTES), Buffer.from('x'));
  assert.ok(isOk(sealed));
  if (!isOk(sealed)) return;
  const opened = open(randomBytes(AES_KEY_BYTES), sealed.value);
  assert.ok(isErr(opened));
  if (isErr(opened)) assert.equal(opened.error.code, 'DECRYPT_FAILED');
});

test('detects tampered ciphertext (GCM integrity)', () => {
  const key = randomBytes(AES_KEY_BYTES);
  const sealed = seal(key, Buffer.from('important'));
  assert.ok(isOk(sealed));
  if (!isOk(sealed)) return;
  // Flip a byte in the ciphertext.
  const ct = Buffer.from(sealed.value.ciphertext, 'hex');
  ct[0] = ct[0]! ^ 0xff;
  const tampered = { ...sealed.value, ciphertext: ct.toString('hex') };
  assert.ok(isErr(open(key, tampered)));
});

test('AAD mismatch fails decryption', () => {
  const key = randomBytes(AES_KEY_BYTES);
  const sealed = seal(key, Buffer.from('bound'), Buffer.from('user:1'));
  assert.ok(isOk(sealed));
  if (!isOk(sealed)) return;
  assert.ok(isErr(open(key, sealed.value, Buffer.from('user:2'))));
  assert.ok(isOk(open(key, sealed.value, Buffer.from('user:1'))));
});

test('rejects wrong key length', () => {
  assert.ok(isErr(seal(randomBytes(16), Buffer.from('x'))));
});

test('wipe zeroes buffers', () => {
  const b = Buffer.from([1, 2, 3, 4]);
  wipe(b);
  assert.deepEqual([...b], [0, 0, 0, 0]);
});

test('constantTimeEqual', () => {
  assert.equal(constantTimeEqual(Buffer.from('abc'), Buffer.from('abc')), true);
  assert.equal(constantTimeEqual(Buffer.from('abc'), Buffer.from('abd')), false);
  assert.equal(constantTimeEqual(Buffer.from('abc'), Buffer.from('ab')), false);
});
