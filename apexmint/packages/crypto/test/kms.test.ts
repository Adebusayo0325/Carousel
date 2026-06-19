import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { LocalKms, CloudKmsNotConfigured } from '../src/kms.js';
import { isErr, isOk } from '@apexmint/core';

test('LocalKms refuses all-zero root key', () => {
  const r = LocalKms.create({ rootKeyHex: '00'.repeat(32) });
  assert.ok(isErr(r));
  if (isErr(r)) assert.equal(r.error.code, 'WEAK_ROOT_KEY');
});

test('LocalKms refuses wrong-length root key', () => {
  assert.ok(isErr(LocalKms.create({ rootKeyHex: 'abcd' })));
});

test('wrap then unwrap round-trips a DEK', async () => {
  const k = LocalKms.create({ rootKeyHex: randomBytes(32).toString('hex') });
  assert.ok(isOk(k));
  if (!isOk(k)) return;
  const dek = randomBytes(32);
  const wrapped = await k.value.wrapDek(dek);
  assert.ok(isOk(wrapped));
  if (!isOk(wrapped)) return;
  const unwrapped = await k.value.unwrapDek(wrapped.value);
  assert.ok(isOk(unwrapped));
  if (isOk(unwrapped)) assert.ok(unwrapped.value.equals(dek));
});

test('rotation: retired key id can still unwrap old DEKs', async () => {
  const oldHex = randomBytes(32).toString('hex');
  const k1 = LocalKms.create({ rootKeyHex: oldHex, keyId: 'old' });
  assert.ok(isOk(k1));
  if (!isOk(k1)) return;
  const dek = randomBytes(32);
  const wrapped = await k1.value.wrapDek(dek);
  assert.ok(isOk(wrapped));
  if (!isOk(wrapped)) return;

  // New KMS with a fresh active key, retaining the old one for unwrap.
  const k2 = LocalKms.create({
    rootKeyHex: randomBytes(32).toString('hex'),
    keyId: 'new',
    retired: { old: oldHex },
  });
  assert.ok(isOk(k2));
  if (!isOk(k2)) return;
  const unwrapped = await k2.value.unwrapDek(wrapped.value);
  assert.ok(isOk(unwrapped));
  if (isOk(unwrapped)) assert.ok(unwrapped.value.equals(dek));
});

test('unknown key id is rejected', async () => {
  const k = LocalKms.create({ rootKeyHex: randomBytes(32).toString('hex'), keyId: 'a' });
  assert.ok(isOk(k));
  if (!isOk(k)) return;
  const dek = randomBytes(32);
  const wrapped = await k.value.wrapDek(dek);
  assert.ok(isOk(wrapped));
  if (!isOk(wrapped)) return;
  const forged = { ...wrapped.value, keyId: 'does-not-exist' };
  assert.ok(isErr(await k.value.unwrapDek(forged)));
});

test('cloud KMS seam fails closed (not silently)', async () => {
  const aws = new CloudKmsNotConfigured('aws', 'arn:...');
  const r = await aws.wrapDek(randomBytes(32));
  assert.ok(isErr(r));
  if (isErr(r)) assert.equal(r.error.code, 'KMS_NOT_CONFIGURED');
});
