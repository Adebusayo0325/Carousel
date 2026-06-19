/**
 * Signer abstraction.
 *
 * A `VaultSigner` bridges the vault to the chain adapters' `SignFn`. The actual
 * elliptic-curve signing is delegated to a `RawSigner` provided by the chain
 * layer (ethers for EVM, tweetnacl/web3.js for Solana) so this package stays
 * free of chain-specific crypto deps. The private key is materialized for the
 * shortest possible window: unwrap → sign → wipe.
 *
 * This is also the integration seam for hardware wallets, MPC, and KMS-side
 * signing: a `RawSigner` that never exposes the key (it signs remotely) plugs in
 * here with zero changes to callers. See `ExternalSigner`.
 */

import type { AppError, Result, SignPayload, SignResult } from '@apexmint/core';
import { Errors, err, ok } from '@apexmint/core';
import { wipe } from './secretbox.js';
import { openWallet, type VaultRecord } from './vault.js';
import type { KmsProvider } from './kms.js';

/**
 * Chain-specific raw signing. Receives the plaintext private key and the payload
 * to sign; returns the serialized signed transaction. Implementations MUST NOT
 * retain the key beyond the call.
 */
export type RawSigner = (
  privateKey: Buffer,
  payload: SignPayload,
) => Promise<Result<SignResult, AppError>>;

/**
 * A signer that decrypts a vault record just-in-time. The passphrase is supplied
 * per-signing-session (e.g. unlocked into a short-lived in-memory session in the
 * worker) and never persisted.
 */
export class VaultSigner {
  readonly #kms: KmsProvider;
  readonly #record: VaultRecord;
  readonly #passphrase: string;
  readonly #raw: RawSigner;

  constructor(kms: KmsProvider, record: VaultRecord, passphrase: string, raw: RawSigner) {
    this.#kms = kms;
    this.#record = record;
    this.#passphrase = passphrase;
    this.#raw = raw;
  }

  get address(): string {
    return this.#record.address;
  }

  /** The `SignFn` shape the chain adapters consume. */
  sign = async (payload: SignPayload): Promise<SignResult> => {
    const result = await this.signResult(payload);
    if (!result.ok) {
      // Adapters' SignFn signature is non-Result; surface as a thrown AppError
      // which the adapter's fromPromise boundary will recapture. This is the one
      // sanctioned throw, and it carries a typed AppError (never a raw key).
      throw result.error;
    }
    return result.value;
  };

  /** Result-returning variant for callers that want to stay exception-free. */
  async signResult(payload: SignPayload): Promise<Result<SignResult, AppError>> {
    if (payload.chainFamily !== this.#record.chainFamily) {
      return err(
        Errors.validation('SIGNER_FAMILY_MISMATCH', 'Signer family does not match payload', {
          expected: this.#record.chainFamily,
          got: payload.chainFamily,
        }),
      );
    }
    const priv = await openWallet(this.#kms, this.#record, this.#passphrase);
    if (!priv.ok) return priv;
    try {
      return await this.#raw(priv.value, payload);
    } finally {
      wipe(priv.value); // key lifetime ends here, success or failure
    }
  }
}

/**
 * External signer seam (hardware wallet / MPC / KMS-side signing). The key never
 * exists in our process at all; `signRemote` performs the signature wherever the
 * key lives. Declared as a typed seam — concrete integrations (Fireblocks,
 * Turnkey, Ledger) implement `signRemote`.
 */
export interface ExternalSignerBackend {
  readonly address: string;
  signRemote(payload: SignPayload): Promise<Result<SignResult, AppError>>;
}

export class ExternalSigner {
  readonly #backend: ExternalSignerBackend;
  constructor(backend: ExternalSignerBackend) {
    this.#backend = backend;
  }
  get address(): string {
    return this.#backend.address;
  }
  sign = async (payload: SignPayload): Promise<SignResult> => {
    const r = await this.#backend.signRemote(payload);
    if (!r.ok) throw r.error;
    return r.value;
  };
}

export function notImplementedExternalBackend(address: string): ExternalSignerBackend {
  return {
    address,
    async signRemote() {
      return err(
        Errors.internal('EXTERNAL_SIGNER_NOT_CONFIGURED', 'External signer backend not configured', {
          retriable: false,
        }),
      );
    },
  };
}
