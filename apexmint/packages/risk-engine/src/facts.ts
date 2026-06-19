/**
 * RiskFacts — the normalized inputs to the risk engine.
 *
 * The engine is PURE: a caller (the chain adapter + contract-intel) gathers
 * these facts via RPC/explorer/simulation, then the engine scores them. This
 * keeps scoring deterministic and unit-testable, and lets us reuse the exact
 * same scoring across every EVM chain and Solana.
 *
 * Every field is optional because data availability varies by chain/explorer.
 * Missing data is treated as *uncertainty* (a mild risk contribution), never as
 * "safe" — failing open would defeat the purpose.
 */

import type { ProxyKind } from '@apexmint/contract-intel';

export interface RiskFacts {
  // ── Ownership / authority ──
  /** Whether ownership has been renounced (owner == address(0)). */
  readonly ownershipRenounced?: boolean;
  /** Owner is an EOA (vs. a multisig/timelock contract). EOAs are riskier. */
  readonly ownerIsEoa?: boolean;
  /** Owner is a known timelock/multisig. */
  readonly ownerIsTimelock?: boolean;

  // ── Upgradeability ──
  readonly proxyKind?: ProxyKind;
  /** Implementation changed within the recent observation window. */
  readonly recentlyUpgraded?: boolean;

  // ── Dangerous capabilities (from bytecode/ABI inspection) ──
  /** Contract exposes an owner-only withdraw of user funds beyond mint proceeds. */
  readonly hasArbitraryWithdraw?: boolean;
  /** Contract can blacklist / freeze holders. */
  readonly hasBlacklist?: boolean;
  /** Transfers can be disabled / restricted by the owner (honeypot vector). */
  readonly hasTradingRestriction?: boolean;
  /** Mint can be paused by the owner. */
  readonly hasMintPause?: boolean;
  /** Max supply is mutable after deploy (supply manipulation). */
  readonly supplyMutable?: boolean;
  /** Owner can mint to themselves without payment. */
  readonly hasOwnerMint?: boolean;
  /** Metadata (tokenURI/baseURI) is mutable post-mint. */
  readonly metadataMutable?: boolean;

  // ── Honeypot / sellability (from simulation) ──
  /** A simulated buy-then-sell succeeded. If false with high confidence => honeypot. */
  readonly simulatedSellSucceeded?: boolean;
  /** Effective sell tax/royalty fraction 0..1 discovered in simulation. */
  readonly sellTaxBps?: number;

  // ── Liquidity / market (for the secondary-sale path) ──
  /** Marketplace floor liquidity present (any active bids/listings). */
  readonly hasSecondaryLiquidity?: boolean;

  // ── Provenance ──
  /** Source code is verified on the explorer. */
  readonly sourceVerified?: boolean;
  /** Deployer wallet age in days (very new deployer is riskier). */
  readonly deployerAgeDays?: number;
}
