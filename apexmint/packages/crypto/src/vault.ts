/**
 * WalletVault — non-custodial, two-layer key storage.
 *
 * THE NO-BACKDOOR GUARANTEE
 * -------------------------
 * A naive "encrypt everything with a KMS key" design is a backdoor: whoever
 * controls the KMS (the operator) can decrypt every user's key. We defeat that
 * with two independent layers that must BOTH be defeated to recover a key:
 *
 *   plaintextPrivKey
 *     --(seal with userKey = scrypt(passphrase))-->  innerBox      [user layer]
 *     --(seal with DEK)-------------------------->  outerBox      [server layer]
 *   DEK --(wrap with KMS root)-----------------> wrappedDek
 *
 * At rest we persist ONLY: { wrappedDek, kdfParams(salt+cost), outerBox }.
 * We persist NEITHER the passphrase NOR the userKey NOR the DEK in plaintext.
 *
 * Threat analysis:
 *   • DB theft (no KMS)         → cannot unwrap DEK → cannot even reach innerBox.
 *   • DB + KMS (the operator!)  → unwraps DEK, strips outerBox, then hits the
 *                                 passphrase-derived inner layer it cannot cross.
 *   • DB + KMS + passphrase     → can decrypt (this is the legitimate user).
 *
 * => The admin/operator CANNOT unilaterally decrypt or move user funds. This is
 *    the architectural answer to the spec's contradiction between "bulletproof,
 *    never plaintext" and "admin has total access to wallets."
 *
 * AAD binding ties every box to (userId, walletId) so a stolen blob cannot be
 * replayed onto a different user/wallet record.
 */

import { Errors, type AppError } from '@apexmint/core';
import { err, ok, type Result } from '@apexmint/core';
import { open, seal, wipe, randomBytes, AES_KEY_BYTES, type SealedBox } from './secretbox.js';
import { deriveKey, defaultKdfParams, type KdfParams } from './kdf.js';
import type { KmsProvider, WrappedDek } from './kms.js';

/** Persisted, at-rest representation. Contains NO plaintext secret. */
export interface VaultRecord {
  readonly version: 1;
  readonly userId: string;
  readonly walletId: string;
  readonly wrappedDek: WrappedDek;
  readonly kdf: KdfParams;
  readonly outerBox: SealedBox;
  /** Public metadata only. */
  readonly address: string;
  readonly chainFamily: 'evm' | 'svm';
}

export interface SealWalletInput {
  readonly userId: string;
  readonly walletId: string;
  readonly address: string;
  readonly chainFamily: 'evm' | 'svm';
  /** Plaintext private key bytes. Wiped by this function before it returns. */
  readonly privateKey: Buffer;
  /** User passphrase — the factor the server never persists. */
  readonly passphrase: string;
}

function aadFor(userId: string, walletId: string): Buffer {
  return Buffer.from(`apexmint:v1:${userId}:${walletId}`);
}

/** Encrypt a private key into a persistable VaultRecord. */
export async function sealWallet(
  kms: KmsProvider,
  input: SealWalletInput,
): Promise<Result<VaultRecord, AppError>> {
  const aad = aadFor(input.userId, input.walletId);

  // ── inner (user) layer ──
  const kdf = defaultKdfParams();
  const userKey = await deriveKey(input.passphrase, kdf);
  if (!userKey.ok) {
    wipe(input.privateKey);
    return userKey;
  }
  const innerBox = seal(userKey.value, input.privateKey, aad);
  wipe(userKey.value, input.privateKey); // secrets gone from our control ASAP
  if (!innerBox.ok) return innerBox;

  // ── outer (server/KMS) layer ──
  const dek = randomBytes(AES_KEY_BYTES);
  const innerSerialized = Buffer.from(JSON.stringify(innerBox.value), 'utf8');
  const outerBox = seal(dek, innerSerialized, aad);
  if (!outerBox.ok) {
    wipe(dek);
    return outerBox;
  }
  const wrapped = await kms.wrapDek(dek);
  wipe(dek);
  if (!wrapped.ok) return wrapped;

  return ok({
    version: 1,
    userId: input.userId,
    walletId: input.walletId,
    wrappedDek: wrapped.value,
    kdf,
    outerBox: outerBox.value,
    address: input.address,
    chainFamily: input.chainFamily,
  });
}

/**
 * Decrypt a VaultRecord back to the plaintext private key.
 *
 * Requires BOTH the KMS (to unwrap the DEK) AND the correct passphrase (to cross
 * the inner layer). The returned Buffer is the caller's responsibility to wipe()
 * immediately after signing.
 */
export async function openWallet(
  kms: KmsProvider,
  record: VaultRecord,
  passphrase: string,
): Promise<Result<Buffer, AppError>> {
  const aad = aadFor(record.userId, record.walletId);

  // ── strip outer (server/KMS) layer ──
  const dek = await kms.unwrapDek(record.wrappedDek);
  if (!dek.ok) return dek;
  const innerSerialized = open(dek.value, record.outerBox, aad);
  wipe(dek.value);
  if (!innerSerialized.ok) return innerSerialized;

  let innerBox: SealedBox;
  try {
    innerBox = JSON.parse(innerSerialized.value.toString('utf8')) as SealedBox;
  } catch {
    return err(Errors.crypto('CORRUPT_VAULT', 'Inner box is not valid JSON'));
  }

  // ── strip inner (user) layer ──
  const userKey = await deriveKey(passphrase, record.kdf);
  if (!userKey.ok) return userKey;
  const privateKey = open(userKey.value, innerBox, aad);
  wipe(userKey.value);
  if (!privateKey.ok) {
    // Most likely a wrong passphrase (GCM auth fail). Report as auth, not crypto,
    // so the API returns 401 and we can rate-limit attempts.
    return err(Errors.auth('WRONG_PASSPHRASE', 'Incorrect passphrase or corrupt vault'));
  }
  return privateKey;
}

/**
 * Re-wrap the outer DEK under the KMS's current active key WITHOUT needing the
 * passphrase. This enables KMS key rotation: the operator can rotate the root
 * key for every wallet without ever seeing a private key (the inner layer stays
 * sealed throughout). This is rotation that respects the no-backdoor property.
 */
export async function rotateKms(
  kms: KmsProvider,
  record: VaultRecord,
): Promise<Result<VaultRecord, AppError>> {
  const dek = await kms.unwrapDek(record.wrappedDek);
  if (!dek.ok) return dek;
  const rewrapped = await kms.wrapDek(dek.value);
  wipe(dek.value);
  if (!rewrapped.ok) return rewrapped;
  return ok({ ...record, wrappedDek: rewrapped.value });
}

/**
 * Re-encrypt the INNER layer under a new passphrase. Requires the old
 * passphrase, so only the user can do this — the operator cannot reset it
 * (a reset would be a backdoor). Lost passphrase => lost wallet, by design.
 */
export async function changePassphrase(
  kms: KmsProvider,
  record: VaultRecord,
  oldPassphrase: string,
  newPassphrase: string,
): Promise<Result<VaultRecord, AppError>> {
  const priv = await openWallet(kms, record, oldPassphrase);
  if (!priv.ok) return priv;
  return sealWallet(kms, {
    userId: record.userId,
    walletId: record.walletId,
    address: record.address,
    chainFamily: record.chainFamily,
    privateKey: priv.value, // sealWallet wipes it
    passphrase: newPassphrase,
  });
}
