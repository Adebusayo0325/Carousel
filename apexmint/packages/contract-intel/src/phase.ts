/**
 * Sale-phase inference & mint-parameter inference.
 *
 * Requirements: "Sale phase inference", "Mint parameter inference". Given a set
 * of on-chain reads (start/end timestamps, price, per-wallet caps, paused
 * flags) the engine infers the current phase and whether a mint is viable RIGHT
 * NOW, plus the parameters to use. Reads are passed in as a plain object so this
 * is pure and testable; the chain adapter is responsible for fetching them.
 */

export type SalePhase = 'pre' | 'allowlist' | 'public' | 'ended' | 'paused' | 'unknown';

export interface PhaseInputs {
  /** Unix seconds. */
  readonly now: number;
  readonly publicStart?: number;
  readonly publicEnd?: number;
  readonly allowlistStart?: number;
  readonly allowlistEnd?: number;
  readonly paused?: boolean;
  readonly totalSupply?: number;
  readonly maxSupply?: number;
}

export interface PhaseInference {
  readonly phase: SalePhase;
  /** Can a public (non-allowlisted) wallet mint right now? */
  readonly publicMintable: boolean;
  /** Seconds until the next actionable moment (e.g. public start), or null. */
  readonly secondsUntilNext: number | null;
  readonly evidence: readonly string[];
}

export function inferPhase(input: PhaseInputs): PhaseInference {
  const ev: string[] = [];

  if (input.paused === true) {
    return { phase: 'paused', publicMintable: false, secondsUntilNext: null, evidence: ['paused flag set'] };
  }

  if (
    input.maxSupply !== undefined &&
    input.totalSupply !== undefined &&
    input.totalSupply >= input.maxSupply
  ) {
    return { phase: 'ended', publicMintable: false, secondsUntilNext: null, evidence: ['supply exhausted'] };
  }

  const { now } = input;

  if (input.publicEnd !== undefined && now >= input.publicEnd) {
    ev.push('past public end');
    return { phase: 'ended', publicMintable: false, secondsUntilNext: null, evidence: ev };
  }

  if (input.publicStart !== undefined) {
    if (now >= input.publicStart) {
      ev.push('within public window');
      return { phase: 'public', publicMintable: true, secondsUntilNext: null, evidence: ev };
    }
    // Before public start — maybe allowlist is live.
    if (
      input.allowlistStart !== undefined &&
      now >= input.allowlistStart &&
      (input.allowlistEnd === undefined || now < input.allowlistEnd)
    ) {
      ev.push('within allowlist window, before public');
      return {
        phase: 'allowlist',
        publicMintable: false,
        secondsUntilNext: input.publicStart - now,
        evidence: ev,
      };
    }
    ev.push('before public start');
    return {
      phase: 'pre',
      publicMintable: false,
      secondsUntilNext: input.publicStart - now,
      evidence: ev,
    };
  }

  if (
    input.allowlistStart !== undefined &&
    now >= input.allowlistStart &&
    (input.allowlistEnd === undefined || now < input.allowlistEnd)
  ) {
    ev.push('allowlist live, no public schedule known');
    return { phase: 'allowlist', publicMintable: false, secondsUntilNext: null, evidence: ev };
  }

  return { phase: 'unknown', publicMintable: false, secondsUntilNext: null, evidence: ['insufficient schedule data'] };
}

export interface MintParams {
  readonly unitPriceRaw: string;
  readonly maxPerWallet: number | null;
  readonly remainingSupply: number | null;
}

export interface MintParamInputs {
  readonly priceRaw?: string;
  readonly maxPerWallet?: number;
  readonly totalSupply?: number;
  readonly maxSupply?: number;
}

export function inferMintParams(input: MintParamInputs): MintParams {
  const remaining =
    input.maxSupply !== undefined && input.totalSupply !== undefined
      ? Math.max(0, input.maxSupply - input.totalSupply)
      : null;
  return {
    unitPriceRaw: input.priceRaw ?? '0',
    maxPerWallet: input.maxPerWallet ?? null,
    remainingSupply: remaining,
  };
}
