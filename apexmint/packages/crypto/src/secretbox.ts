/**
 * Authenticated symmetric encryption primitive: AES-256-GCM.
 *
 * Audit requirement: "AES-256-GCM encryption". GCM gives us confidentiality
 * AND integrity (the auth tag), so tampered ciphertext is rejected at decrypt
 * time rather than silently producing garbage. We bind Additional Authenticated
 * Data (AAD) so a ciphertext can't be replayed in a different context (e.g. a
 * wallet blob can't be pasted onto another user's record without failing auth).
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { Errors, type AppError } from '@apexmint/core';
import { err, ok, type Result } from '@apexmint/core';

export const AES_KEY_BYTES = 32; // 256-bit
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16;

export interface SealedBox {
  /** 12-byte random nonce, hex. */
  readonly iv: string;
  /** 16-byte GCM auth tag, hex. */
  readonly tag: string;
  /** Ciphertext, hex. */
  readonly ciphertext: string;
}

/** Encrypt `plaintext` under a 32-byte key with optional AAD binding. */
export function seal(
  key: Buffer,
  plaintext: Buffer,
  aad?: Buffer,
): Result<SealedBox, AppError> {
  if (key.length !== AES_KEY_BYTES) {
    return err(Errors.crypto('BAD_KEY_LEN', `Key must be ${AES_KEY_BYTES} bytes`));
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ok({
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  });
}

/** Decrypt a {@link SealedBox}. Fails closed on any tampering or wrong AAD. */
export function open(key: Buffer, box: SealedBox, aad?: Buffer): Result<Buffer, AppError> {
  if (key.length !== AES_KEY_BYTES) {
    return err(Errors.crypto('BAD_KEY_LEN', `Key must be ${AES_KEY_BYTES} bytes`));
  }
  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(box.iv, 'hex');
    tag = Buffer.from(box.tag, 'hex');
    ciphertext = Buffer.from(box.ciphertext, 'hex');
  } catch {
    return err(Errors.crypto('BAD_BOX', 'Sealed box fields are not valid hex'));
  }
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    return err(Errors.crypto('BAD_BOX', 'Sealed box has wrong iv/tag length'));
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return ok(plaintext);
  } catch {
    // GCM auth failure: tampered ciphertext, wrong key, or wrong AAD.
    return err(Errors.crypto('DECRYPT_FAILED', 'Authenticated decryption failed'));
  }
}

/**
 * Best-effort in-place zeroization of sensitive Buffers.
 *
 * NOTE (honesty): JavaScript cannot guarantee secret erasure — the GC may have
 * already copied the bytes, and `string` keys are immutable. We therefore work
 * with Buffers wherever possible and wipe them promptly. This reduces, but does
 * not eliminate, the window a secret sits in memory. Hardware/MPC/KMS signing
 * (see kms.ts) is the answer where that residual risk is unacceptable.
 */
export function wipe(...buffers: Buffer[]): void {
  for (const b of buffers) b.fill(0);
}

/** Constant-time equality for secrets (e.g. comparing derived keys). */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export { randomBytes };
