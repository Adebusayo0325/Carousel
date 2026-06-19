/**
 * KMS abstraction for envelope encryption.
 *
 * Audit requirements: "Envelope encryption", "KMS support (AWS/GCP/Azure)",
 * "Secret rotation". A KMS holds the *root* key and performs wrap/unwrap of
 * per-record Data Encryption Keys (DEKs). The DEK never leaves the process in
 * plaintext at rest; the root key never leaves the KMS at all.
 *
 * Providers implement `wrapDek`/`unwrapDek`. The cloud providers are declared
 * here as typed seams (so wiring them is a drop-in) with a fully-working
 * `LocalKms` for development and tests.
 */

import { Errors, type AppError } from '@apexmint/core';
import { err, ok, type Result } from '@apexmint/core';
import { AES_KEY_BYTES, open, seal, type SealedBox } from './secretbox.js';

export interface WrappedDek {
  /** Identifies which root key wrapped this DEK (enables rotation). */
  readonly keyId: string;
  readonly provider: KmsProviderName;
  /** Provider-specific wrapped form. For local: a SealedBox; cloud: ciphertext blob. */
  readonly material: SealedBox | string;
}

export type KmsProviderName = 'local' | 'aws' | 'gcp' | 'azure';

export interface KmsProvider {
  readonly name: KmsProviderName;
  readonly activeKeyId: string;
  /** Encrypt (wrap) a 32-byte DEK with the root key. */
  wrapDek(dek: Buffer): Promise<Result<WrappedDek, AppError>>;
  /** Decrypt (unwrap) a previously wrapped DEK. */
  unwrapDek(wrapped: WrappedDek): Promise<Result<Buffer, AppError>>;
}

/**
 * Development / test KMS. The "root key" is supplied from env. In production you
 * MUST use a real KMS — see SECURITY.md. We make that explicit by refusing a
 * weak/empty root key.
 */
export class LocalKms implements KmsProvider {
  readonly name = 'local' as const;
  readonly activeKeyId: string;
  readonly #rootKey: Buffer;
  /** Older roots kept for unwrap-only during rotation. */
  readonly #retiredRoots: ReadonlyMap<string, Buffer>;

  private constructor(keyId: string, rootKey: Buffer, retired: Map<string, Buffer>) {
    this.activeKeyId = keyId;
    this.#rootKey = rootKey;
    this.#retiredRoots = retired;
  }

  static create(opts: {
    rootKeyHex: string;
    keyId?: string;
    retired?: Record<string, string>;
  }): Result<LocalKms, AppError> {
    const root = decodeKey(opts.rootKeyHex);
    if (!root.ok) return root;
    const retired = new Map<string, Buffer>();
    for (const [id, hex] of Object.entries(opts.retired ?? {})) {
      const k = decodeKey(hex);
      if (!k.ok) return k;
      retired.set(id, k.value);
    }
    return ok(new LocalKms(opts.keyId ?? 'local-1', root.value, retired));
  }

  async wrapDek(dek: Buffer): Promise<Result<WrappedDek, AppError>> {
    if (dek.length !== AES_KEY_BYTES) {
      return err(Errors.crypto('BAD_DEK', 'DEK must be 32 bytes'));
    }
    const sealed = seal(this.#rootKey, dek, Buffer.from(`kms:${this.activeKeyId}`));
    if (!sealed.ok) return sealed;
    return ok({ keyId: this.activeKeyId, provider: this.name, material: sealed.value });
  }

  async unwrapDek(wrapped: WrappedDek): Promise<Result<Buffer, AppError>> {
    if (wrapped.provider !== 'local') {
      return err(Errors.crypto('WRONG_PROVIDER', `Expected local, got ${wrapped.provider}`));
    }
    if (typeof wrapped.material === 'string') {
      return err(Errors.crypto('BAD_WRAPPED', 'Local KMS expects a sealed box'));
    }
    const rootKey =
      wrapped.keyId === this.activeKeyId
        ? this.#rootKey
        : this.#retiredRoots.get(wrapped.keyId);
    if (!rootKey) {
      return err(Errors.crypto('UNKNOWN_KEY_ID', `No root key for id ${wrapped.keyId}`));
    }
    return open(rootKey, wrapped.material, Buffer.from(`kms:${wrapped.keyId}`));
  }
}

function decodeKey(hex: string): Result<Buffer, AppError> {
  let buf: Buffer;
  try {
    buf = Buffer.from(hex, 'hex');
  } catch {
    return err(Errors.crypto('BAD_ROOT_KEY', 'Root key is not valid hex'));
  }
  if (buf.length !== AES_KEY_BYTES) {
    return err(
      Errors.crypto('BAD_ROOT_KEY', `Root key must be ${AES_KEY_BYTES} bytes (64 hex chars)`),
    );
  }
  // Refuse an all-zero key — the single most common dev footgun.
  if (buf.every((b) => b === 0)) {
    return err(Errors.crypto('WEAK_ROOT_KEY', 'Refusing all-zero KMS root key'));
  }
  return ok(buf);
}

/**
 * Typed seam for a cloud KMS. Throwing `not implemented` keeps the build honest:
 * the integration point is declared and type-checked, but we do not pretend it
 * works until the SDK is wired and credentials are present.
 */
export class CloudKmsNotConfigured implements KmsProvider {
  readonly name: KmsProviderName;
  readonly activeKeyId: string;
  constructor(name: Exclude<KmsProviderName, 'local'>, keyId: string) {
    this.name = name;
    this.activeKeyId = keyId;
  }
  async wrapDek(_dek: Buffer): Promise<Result<WrappedDek, AppError>> {
    return err(
      Errors.crypto('KMS_NOT_CONFIGURED', `${this.name} KMS not configured in this build`, {
        retriable: false,
      }),
    );
  }
  async unwrapDek(_wrapped: WrappedDek): Promise<Result<Buffer, AppError>> {
    return err(
      Errors.crypto('KMS_NOT_CONFIGURED', `${this.name} KMS not configured in this build`, {
        retriable: false,
      }),
    );
  }
}
