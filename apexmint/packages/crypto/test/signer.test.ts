import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { LocalKms } from '../src/kms.js';
import { sealWallet } from '../src/vault.js';
import { VaultSigner, ExternalSigner, notImplementedExternalBackend } from '../src/signer.js';
import { ok, err, Errors, isErr, isOk, type SignPayload, type SignResult, type Result, type AppError } from '@apexmint/core';

const PRIV = Buffer.from('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'hex');

async function setup(passphrase = 'pp-123') {
  const kmsR = LocalKms.create({ rootKeyHex: randomBytes(32).toString('hex') });
  if (!isOk(kmsR)) throw new Error('kms');
  const rec = await sealWallet(kmsR.value, {
    userId: 'u1',
    walletId: 'w1',
    address: '0xabc0000000000000000000000000000000000001',
    chainFamily: 'evm',
    privateKey: Buffer.from(PRIV),
    passphrase,
  });
  if (!isOk(rec)) throw new Error('seal');
  return { kms: kmsR.value, record: rec.value, passphrase };
}

test('VaultSigner decrypts JIT, calls raw signer, and wipes the key', async () => {
  const { kms, record, passphrase } = await setup();
  let seenKeyHex = '';
  let keyAfterCall: Buffer | null = null;

  const raw = async (priv: Buffer, _p: SignPayload): Promise<Result<SignResult, AppError>> => {
    seenKeyHex = priv.toString('hex');
    keyAfterCall = priv; // capture reference to verify it gets wiped
    return ok({ signed: '0xsigned' });
  };

  const signer = new VaultSigner(kms, record, passphrase, raw);
  const out = await signer.signResult({ chainFamily: 'evm', chainKey: 'ethereum', data: {} });
  assert.ok(isOk(out));
  if (isOk(out)) assert.equal(out.value.signed, '0xsigned');
  // The raw signer saw the correct key...
  assert.equal(seenKeyHex, PRIV.toString('hex'));
  // ...and after signing, the buffer was zeroed by the finally block.
  assert.ok(keyAfterCall);
  assert.ok((keyAfterCall as unknown as Buffer).every((b) => b === 0));
});

test('VaultSigner.sign throws typed AppError on wrong passphrase', async () => {
  const { kms, record } = await setup();
  const raw = async () => ok({ signed: 'x' });
  const signer = new VaultSigner(kms, record, 'WRONG', raw);
  await assert.rejects(
    () => signer.sign({ chainFamily: 'evm', chainKey: 'ethereum', data: {} }),
    (e: unknown) => (e as AppError).code === 'WRONG_PASSPHRASE',
  );
});

test('VaultSigner rejects family mismatch before touching the key', async () => {
  const { kms, record, passphrase } = await setup();
  let rawCalled = false;
  const raw = async () => {
    rawCalled = true;
    return ok({ signed: 'x' });
  };
  const signer = new VaultSigner(kms, record, passphrase, raw);
  const out = await signer.signResult({ chainFamily: 'svm', chainKey: 'solana', data: {} });
  assert.ok(isErr(out));
  assert.equal(rawCalled, false); // never decrypted
});

test('raw signer failure propagates as Err (no silent success)', async () => {
  const { kms, record, passphrase } = await setup();
  const raw = async () => err(Errors.upstream('SIGN_FAIL', 'device unplugged'));
  const signer = new VaultSigner(kms, record, passphrase, raw);
  const out = await signer.signResult({ chainFamily: 'evm', chainKey: 'ethereum', data: {} });
  assert.ok(isErr(out));
});

test('ExternalSigner seam fails closed until configured', async () => {
  const signer = new ExternalSigner(notImplementedExternalBackend('0xdead'));
  await assert.rejects(() => signer.sign({ chainFamily: 'evm', chainKey: 'ethereum', data: {} }));
  assert.equal(signer.address, '0xdead');
});
