/**
 * Rug-risk scoring engine.
 *
 * Requirement: "Rug risk score (0-100)" built from the individual signals
 * (owner analysis, renounce detection, proxy upgrade risk, withdraw analysis,
 * blacklist, trading restriction, mint pause, supply manipulation, metadata
 * mutability, honeypot).
 *
 * Model: each signal contributes a non-negative number of risk POINTS with a
 * cap. Points sum, then clamp to 100. Higher = riskier. Every contribution is
 * recorded with a human-readable reason so the score is fully explainable (no
 * black box — a user can see exactly WHY a mint was flagged). Mitigating facts
 * (renounced ownership, verified source, timelock owner) SUBTRACT points but the
 * floor is 0.
 *
 * This is intentionally a transparent linear model rather than an opaque ML
 * score: for a security gate, auditability beats marginal accuracy.
 */

import type { RiskFacts } from './facts.js';

export type RiskBand = 'low' | 'medium' | 'high' | 'critical';

export interface RiskContribution {
  readonly signal: string;
  /** Positive = adds risk; negative = mitigates. */
  readonly points: number;
  readonly reason: string;
}

export interface RiskAssessment {
  /** 0..100, higher = riskier. */
  readonly score: number;
  readonly band: RiskBand;
  readonly contributions: readonly RiskContribution[];
  /** True when score is at/above the threshold OR a disqualifying signal fired. */
  readonly blocked: boolean;
  /**
   * Signals that block REGARDLESS of score offsets. A confirmed honeypot is the
   * canonical example: no amount of "renounced + verified" makes an unsellable
   * token acceptable. These force `blocked = true`.
   */
  readonly hardBlocks: readonly string[];
}

export interface RiskConfig {
  /** Score at/above which a mint is hard-blocked by default. */
  readonly blockThreshold: number;
}

export function defaultRiskConfig(): RiskConfig {
  return { blockThreshold: 70 };
}

function band(score: number): RiskBand {
  if (score >= 70) return 'critical';
  if (score >= 45) return 'high';
  if (score >= 20) return 'medium';
  return 'low';
}

/**
 * Score a set of facts. The weights below are deliberately explicit and
 * documented so they can be tuned and reviewed.
 */
export function assessRisk(facts: RiskFacts, config: RiskConfig = defaultRiskConfig()): RiskAssessment {
  const c: RiskContribution[] = [];
  const hardBlocks: string[] = [];
  const add = (signal: string, points: number, reason: string) => {
    if (points !== 0) c.push({ signal, points, reason });
  };

  // ── Honeypot: the single most damaging signal ──
  if (facts.simulatedSellSucceeded === false) {
    add('honeypot', 45, 'Simulated sell FAILED — tokens may be unsellable (honeypot)');
    // A confirmed honeypot is disqualifying on its own, independent of score.
    hardBlocks.push('honeypot');
  } else if (facts.simulatedSellSucceeded === undefined) {
    add('honeypot', 8, 'Sell simulation unavailable — sellability unverified');
  }
  if (facts.sellTaxBps !== undefined && facts.sellTaxBps > 1000) {
    // >10% sell tax
    add('sell_tax', Math.min(20, Math.round((facts.sellTaxBps - 1000) / 500)), `High sell tax ~${(facts.sellTaxBps / 100).toFixed(1)}%`);
  }

  // ── Withdraw / fund-drain capability ──
  if (facts.hasArbitraryWithdraw) {
    add('withdraw', 18, 'Owner can withdraw arbitrary funds from the contract');
  }

  // ── Trading restriction / blacklist (honeypot vectors) ──
  if (facts.hasTradingRestriction) {
    add('trading_restriction', 16, 'Owner can disable/restrict transfers');
  }
  if (facts.hasBlacklist) {
    add('blacklist', 12, 'Contract can blacklist/freeze holders');
  }

  // ── Supply manipulation ──
  if (facts.supplyMutable) {
    add('supply', 12, 'Max supply is mutable after deploy');
  }
  if (facts.hasOwnerMint) {
    add('owner_mint', 8, 'Owner can mint without payment');
  }

  // ── Mint pause ──
  if (facts.hasMintPause) {
    add('mint_pause', 5, 'Mint can be paused by the owner');
  }

  // ── Metadata mutability ──
  if (facts.metadataMutable === true) {
    add('metadata', 6, 'Metadata is mutable post-mint (rug-pull-the-art risk)');
  } else if (facts.metadataMutable === undefined) {
    add('metadata', 2, 'Metadata mutability unknown');
  }

  // ── Upgradeability risk ──
  switch (facts.proxyKind) {
    case 'uups':
    case 'transparent':
    case 'eip1967':
    case 'beacon':
      add('upgradeable', 10, `Contract is upgradeable (${facts.proxyKind}) — logic can change`);
      break;
    case 'unknown-proxy':
      add('upgradeable', 14, 'Proxy detected but pattern unrecognized — opaque upgrade path');
      break;
    default:
      break;
  }
  if (facts.recentlyUpgraded) {
    add('recent_upgrade', 8, 'Implementation changed recently');
  }

  // ── Ownership / authority ──
  if (facts.ownershipRenounced === true) {
    add('ownership', -15, 'Ownership renounced — owner-only rug vectors neutralized');
  } else {
    if (facts.ownerIsTimelock) {
      add('ownership', -6, 'Owner is a timelock/multisig — changes are delayed/governed');
    } else if (facts.ownerIsEoa === true) {
      add('ownership', 10, 'Owner is an EOA — single key controls privileged functions');
    } else {
      add('ownership', 4, 'Active owner with privileged functions');
    }
  }

  // ── Provenance ──
  if (facts.sourceVerified === true) {
    add('verified', -8, 'Source code verified on explorer');
  } else if (facts.sourceVerified === false) {
    add('verified', 10, 'Source code NOT verified — cannot audit behavior');
  }
  if (facts.deployerAgeDays !== undefined && facts.deployerAgeDays < 3) {
    add('deployer_age', 8, `Deployer wallet is only ${facts.deployerAgeDays}d old`);
  }

  // ── Secondary liquidity (affects exit, not safety of mint itself) ──
  if (facts.hasSecondaryLiquidity === false) {
    add('liquidity', 5, 'No secondary-market liquidity — hard to exit');
  }

  const raw = c.reduce((sum, x) => sum + x.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  return {
    score,
    band: band(score),
    contributions: c,
    blocked: score >= config.blockThreshold || hardBlocks.length > 0,
    hardBlocks,
  };
}
