/**
 * Chain abstraction — the plugin contract.
 *
 * Requirement: "Plugin-based chain architecture. New chains can be added
 * through chain adapters without changing core code." Core defines only the
 * vocabulary (families, descriptors) and the `ChainAdapter` interface. Concrete
 * adapters live in @apexmint/chains and self-register; nothing here imports a
 * concrete chain.
 */

import type { Result } from './result.js';
import type { AppError } from './errors.js';

/** Coarse family that determines which signing & encoding rules apply. */
export type ChainFamily = 'evm' | 'svm'; // svm = Solana VM

/** Numeric EVM chain id, or a Solana cluster moniker. */
export type ChainId = number | 'solana-mainnet' | 'solana-devnet';

export interface NativeCurrency {
  readonly symbol: string;
  readonly decimals: number;
}

/** Static, declarative description of a supported chain. */
export interface ChainDescriptor {
  /** Stable slug used in APIs and configs, e.g. "ethereum", "base", "solana". */
  readonly key: string;
  readonly family: ChainFamily;
  readonly chainId: ChainId;
  readonly displayName: string;
  readonly nativeCurrency: NativeCurrency;
  /** Default public RPC endpoints; users/enterprise can override. */
  readonly defaultRpcUrls: readonly string[];
  readonly explorerUrl?: string;
  /** Whether MEV-protection bundles are available (Flashbots / Jito). */
  readonly supportsBundles: boolean;
  readonly testnet: boolean;
}

/** A normalized, chain-agnostic mint request. */
export interface MintRequest {
  readonly chainKey: string;
  readonly contract: string;
  /** Destination wallet address (the user's, never the operator's). */
  readonly recipient: string;
  readonly quantity: number;
  /** Price per unit in the chain's smallest unit (wei / lamports), as string. */
  readonly unitPriceRaw: string;
  /** Optional explicit mint function selector / instruction discriminator. */
  readonly methodHint?: string;
  /** Free-form, adapter-interpreted params (allowlist proofs, phase id, etc.). */
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface FeeEstimate {
  /** Total estimated cost in smallest units (gas + value), as string. */
  readonly totalCostRaw: string;
  /** Gas/compute units estimated. */
  readonly computeRaw: string;
  /** Effective per-unit fee (gwei / micro-lamports), as string. */
  readonly unitFeeRaw: string;
  /** Human note about the fee strategy used. */
  readonly strategy: string;
}

export interface SimulationOutcome {
  readonly willSucceed: boolean;
  /** 0..1 heuristic confidence. */
  readonly successProbability: number;
  /** Classified revert reason if the sim failed. */
  readonly revertReason?: string;
  readonly gasUsedRaw?: string;
  readonly notes: readonly string[];
}

export interface PreparedTransaction {
  readonly chainKey: string;
  /** Opaque, adapter-specific unsigned payload (never contains secrets). */
  readonly unsigned: unknown;
  readonly feeEstimate: FeeEstimate;
}

export interface SubmittedTransaction {
  readonly chainKey: string;
  readonly hash: string;
  readonly submittedAt: number;
}

export interface BalanceInfo {
  readonly address: string;
  readonly nativeRaw: string;
}

/**
 * The adapter contract. Implementations are non-custodial: they accept a
 * `Signer` (see @apexmint/crypto) rather than a raw key, so private material is
 * only ever materialized transiently inside a trusted signer, never passed
 * across this boundary in plaintext.
 */
export interface ChainAdapter {
  readonly descriptor: ChainDescriptor;

  getBalance(address: string): Promise<Result<BalanceInfo, AppError>>;

  estimateFee(request: MintRequest): Promise<Result<FeeEstimate, AppError>>;

  /** Build (but do not sign) the mint transaction. */
  prepareMint(request: MintRequest): Promise<Result<PreparedTransaction, AppError>>;

  /** Dry-run against current chain state. */
  simulate(prepared: PreparedTransaction): Promise<Result<SimulationOutcome, AppError>>;

  /**
   * Sign + submit. The `sign` callback is the only thing that can access key
   * material; the adapter hands it the canonical bytes to sign and gets back a
   * signature/serialized tx. This keeps adapters ignorant of key storage.
   */
  submit(
    prepared: PreparedTransaction,
    sign: SignFn,
  ): Promise<Result<SubmittedTransaction, AppError>>;
}

/**
 * Signing callback. Receives an adapter-defined signing payload, returns the
 * signed/serialized form. Implemented by the crypto package's signer, which
 * decrypts the user's key in-memory just-in-time and zeroes it after.
 */
export type SignFn = (payload: SignPayload) => Promise<SignResult>;

export interface SignPayload {
  readonly chainFamily: ChainFamily;
  readonly chainKey: string;
  /** Adapter-specific structure to sign (e.g. an ethers TransactionRequest). */
  readonly data: unknown;
}

export interface SignResult {
  /** Serialized, signed transaction ready for broadcast. */
  readonly signed: string;
}

/** Factory a chain plugin exposes to the registry. */
export interface ChainPlugin {
  readonly descriptor: ChainDescriptor;
  /** Build an adapter bound to a concrete RPC transport/config. */
  create(config: ChainAdapterConfig): ChainAdapter;
}

export interface ChainAdapterConfig {
  /** Ordered RPC endpoints; the adapter should fail over across them. */
  readonly rpcUrls: readonly string[];
  /** Optional override of bundle relay (Flashbots/Jito) endpoint. */
  readonly bundleRelayUrl?: string;
  /** Arbitrary adapter-specific tuning. */
  readonly options?: Readonly<Record<string, unknown>>;
}
