import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { LocalKms } from '../src/kms.js';
import { sealWallet, openWallet, rotateKms, changePassphrase, type VaultRecord } from '../src/vault.js';
import { open } from '../src/secretbox.js';
import { isErr, isOk } from '@apexmint/core';

function kms() {
  const r = LocalKms.create({ rootKeyHex: randomBytes(32).toString('hex') });
  assert.ok(isOk(r));
  if (!isOk(r)) throw new Error('kms');
  return r.value;
}

const PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

async function seal(k = kms(), passphrase = 'correct horse battery staple') {
  const res = await sealWallet(k, {
    userId: 'user-1',
    walletId: 'wallet-1',
    address: '0xabc0000000000000000000000000000000000001',
    chainFamily: 'evm',
    privateKey: Buffer.from(PRIV.slice(2), 'hex'),
    passphrase,
  });
  assert.ok(isOk(res));
  if (!isOk(res)) throw new Error('seal');
  return { k, record: res.value, passphrase };
}

test('seal then open round-trips the private key', async () => {
  const { k, record, passphrase } = await seal();
  const opened = await openWallet(k, record, passphrase);
  assert.ok(isOk(opened));
  if (isOk(opened)) assert.equal('0x' + opened.value.toString('hex'), PRIV);
});

test('record at rest contains NO plaintext private key', async () => {
  const { record } = await seal();
  const blob = JSON.stringify(record);
  assert.ok(!blob.includes(PRIV));
  assert.ok(!blob.includes(PRIV.slice(2)));
  // Only public metadata is present in the clear.
  assert.equal(record.address, '0xabc0000000000000000000000000000000000001');
});

test('NO-BACKDOOR: KMS + full DB record cannot decrypt without passphrase', async () => {
  const { k, record } = await seal();

  // Simulate the operator/admin: they hold the KMS and the entire DB record.
  // Step 1: they CAN unwrap the DEK and strip the outer layer (server layer).
  const dek = await k.unwrapDek(record.wrappedDek);
  assert.ok(isOk(dek), 'operator can unwrap the DEK — expected');
  if (!isOk(dek)) return;

  const aad = Buffer.from(`apexmint:v1:${record.userId}:${record.walletId}`);
  const innerSerialized = open(dek.value, record.outerBox, aad);
  assert.ok(isOk(innerSerialized), 'operator can strip the outer layer — expected');

  // Step 2: but the inner layer is sealed with the passphrase-derived key, which
  // the server NEVER stored. The operator is stuck here.
  const wrongTries = ['', 'password', 'admin', 'correct horse battery stapl'];
  for (const guess of wrongTries) {
    const attempt = await openWallet(k, record, guess);
    assert.ok(isErr(attempt), `guess "${guess}" must fail`);
    if (isErr(attempt)) assert.equal(attempt.error.code, 'WRONG_PASSPHRASE');
  }
});

test('wrong passphrase reports auth error (rate-limitable)', async () => {
  const { k, record } = await seal();
  const r = await openWallet(k, record, 'nope');
  assert.ok(isErr(r));
  if (isErr(r)) assert.equal(r.error.category, 'auth');
});

test('AAD binding: a record cannot be replayed onto another wallet id', async () => {
  const { k, record, passphrase } = await seal();
  const forged: VaultRecord = { ...record, walletId: 'wallet-2' };
  const r = await openWallet(k, forged, passphrase);
  assert.ok(isErr(r)); // outer-layer AAD now mismatches
});

test('KMS rotation re-wraps DEK without needing the passphrase', async () => {
  const { k, record, passphrase } = await seal();
  const rotated = await rotateKms(k, record);
  assert.ok(isOk(rotated));
  if (!isOk(rotated)) return;
  // Outer wrapping changed...
  assert.notDeepEqual(rotated.value.wrappedDek, record.wrappedDek);
  // ...but the user can still open it with the same passphrase.
  const opened = await openWallet(k, rotated.value, passphrase);
  assert.ok(isOk(opened));
  if (isOk(opened)) assert.equal('0x' + opened.value.toString('hex'), PRIV);
});

test('changePassphrase requires the old passphrase', async () => {
  const { k, record, passphrase } = await seal();
  const bad = await changePassphrase(k, record, 'wrong-old', 'new-pass');
  assert.ok(isErr(bad));

  const good = await changePassphrase(k, record, passphrase, 'new-pass-123');
  assert.ok(isOk(good));
  if (!isOk(good)) return;
  // Old passphrase no longer works; new one does.
  assert.ok(isErr(await openWallet(k, good.value, passphrase)));
  const opened = await openWallet(k, good.value, 'new-pass-123');
  assert.ok(isOk(opened));
  if (isOk(opened)) assert.equal('0x' + opened.value.toString('hex'), PRIV);
});
