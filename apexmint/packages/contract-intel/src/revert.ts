/**
 * Revert-reason classification engine.
 *
 * Requirements: "Revert reason classification engine", "Automatic revert
 * analysis". A mint can revert for many reasons; the engine's response should
 * differ (retry later vs. abort vs. raise price vs. wait for phase). We decode
 * revert data into a stable taxonomy with an `action` recommendation.
 *
 * Handles three revert encodings:
 *   • Error(string)         — selector 0x08c379a0, ABI-encoded string.
 *   • Panic(uint256)        — selector 0x4e487b71, Solidity panic codes.
 *   • Custom errors / bare  — matched by selector or by message substring.
 */

import { selectorOf } from './keccak.js';

export type RevertCategory =
  | 'not_started' // sale/phase not live yet
  | 'ended' // sale over / sold out
  | 'sold_out'
  | 'wallet_limit' // per-wallet cap reached
  | 'not_allowlisted' // proof/allowlist failure
  | 'insufficient_payment' // wrong/low msg.value
  | 'paused'
  | 'insufficient_funds' // caller lacks gas/native balance
  | 'arithmetic' // Solidity panic (overflow/div-by-zero)
  | 'access_control'
  | 'unknown';

export type RevertAction =
  | 'retry_when_live' // poll phase, retry at start
  | 'retry_with_higher_value'
  | 'abort' // terminal — don't retry
  | 'retry_backoff' // transient — retry with backoff
  | 'needs_allowlist'; // user action required

export interface RevertClassification {
  readonly category: RevertCategory;
  readonly action: RevertAction;
  /** Decoded human string if we recovered one (sanitized). */
  readonly reason: string | null;
  readonly selector: string | null;
  readonly retriable: boolean;
}

const ERROR_STRING_SELECTOR = '0x08c379a0'; // Error(string)
const PANIC_SELECTOR = '0x4e487b71'; // Panic(uint256)

/** Known custom-error selectors from common NFT launchpads. */
const CUSTOM_ERROR_SELECTORS: ReadonlyMap<string, RevertCategory> = new Map([
  [selectorOf('MintNotActive()'), 'not_started'],
  [selectorOf('SaleNotActive()'), 'not_started'],
  [selectorOf('NotActive()'), 'not_started'],
  [selectorOf('SaleNotStarted()'), 'not_started'],
  [selectorOf('MintEnded()'), 'ended'],
  [selectorOf('SoldOut()'), 'sold_out'],
  [selectorOf('MaxSupplyReached()'), 'sold_out'],
  [selectorOf('ExceedsMaxSupply()'), 'sold_out'],
  [selectorOf('MintQuantityExceedsMaxSupply()'), 'sold_out'],
  [selectorOf('WalletLimitExceeded()'), 'wallet_limit'],
  [selectorOf('MaxPerWalletExceeded()'), 'wallet_limit'],
  [selectorOf('ExceedsMaxPerWallet()'), 'wallet_limit'],
  [selectorOf('MintQuantityExceedsMaxMintedPerWallet()'), 'wallet_limit'],
  [selectorOf('NotAllowlisted()'), 'not_allowlisted'],
  [selectorOf('InvalidProof()'), 'not_allowlisted'],
  [selectorOf('InvalidSignature()'), 'not_allowlisted'],
  [selectorOf('IncorrectPayment()'), 'insufficient_payment'],
  [selectorOf('InsufficientPayment()'), 'insufficient_payment'],
  [selectorOf('WrongValueSent()'), 'insufficient_payment'],
  [selectorOf('Paused()'), 'paused'],
  [selectorOf('EnforcedPause()'), 'paused'],
]);

const CATEGORY_TO_ACTION: Readonly<Record<RevertCategory, { action: RevertAction; retriable: boolean }>> = {
  not_started: { action: 'retry_when_live', retriable: true },
  ended: { action: 'abort', retriable: false },
  sold_out: { action: 'abort', retriable: false },
  wallet_limit: { action: 'abort', retriable: false },
  not_allowlisted: { action: 'needs_allowlist', retriable: false },
  insufficient_payment: { action: 'retry_with_higher_value', retriable: true },
  paused: { action: 'retry_backoff', retriable: true },
  insufficient_funds: { action: 'abort', retriable: false },
  arithmetic: { action: 'abort', retriable: false },
  access_control: { action: 'abort', retriable: false },
  unknown: { action: 'retry_backoff', retriable: true },
};

/** Substring rules applied to a decoded Error(string) message (lowercased). */
const MESSAGE_RULES: ReadonlyArray<[RegExp, RevertCategory]> = [
  [/not (active|started|live)|before start|hasn'?t started/, 'not_started'],
  [/ended|sale over|finished/, 'ended'],
  [/sold ?out|max supply|exceeds? supply|supply exceeded/, 'sold_out'],
  [/per ?wallet|wallet limit|max per|already minted|mint limit/, 'wallet_limit'],
  [/allow ?list|whitelist|merkle|invalid proof|proof|not eligible|invalid signature/, 'not_allowlisted'],
  [/insufficient (payment|value|funds sent)|wrong price|incorrect (payment|price|ether)|underpaid/, 'insufficient_payment'],
  [/paused/, 'paused'],
  [/ownable|caller is not|access|unauthorized|forbidden/, 'access_control'],
  [/insufficient funds/, 'insufficient_funds'],
];

export function classifyRevert(revertData: string): RevertClassification {
  const data = revertData.toLowerCase();
  const hex = data.startsWith('0x') ? data : '0x' + data;

  // Empty revert (no reason) — common for require() with no message.
  if (hex === '0x' || hex.length < 10) {
    return finalize('unknown', null, null);
  }

  const selector = hex.slice(0, 10);

  if (selector === ERROR_STRING_SELECTOR) {
    const decoded = decodeErrorString(hex);
    const category = decoded ? categorizeMessage(decoded) : 'unknown';
    return finalize(category, decoded, selector);
  }

  if (selector === PANIC_SELECTOR) {
    return finalize('arithmetic', `Solidity panic (code ${decodePanicCode(hex)})`, selector);
  }

  const custom = CUSTOM_ERROR_SELECTORS.get(selector);
  if (custom) {
    return finalize(custom, null, selector);
  }

  return finalize('unknown', null, selector);
}

function finalize(
  category: RevertCategory,
  reason: string | null,
  selector: string | null,
): RevertClassification {
  const { action, retriable } = CATEGORY_TO_ACTION[category];
  return { category, action, reason, selector, retriable };
}

function categorizeMessage(message: string): RevertCategory {
  const m = message.toLowerCase();
  for (const [rx, cat] of MESSAGE_RULES) {
    if (rx.test(m)) return cat;
  }
  return 'unknown';
}

/** Decode the ABI string payload of Error(string). Returns null on malformed. */
function decodeErrorString(hex: string): string | null {
  try {
    const body = hex.slice(10); // strip selector
    if (body.length < 128) return null;
    // [0..64) offset, [64..128) length, then the bytes.
    const length = parseInt(body.slice(64, 128), 16);
    if (!Number.isFinite(length) || length <= 0 || length > 4096) return null;
    const strHex = body.slice(128, 128 + length * 2);
    if (strHex.length < length * 2) return null;
    const bytes = Buffer.from(strHex, 'hex');
    return bytes.toString('utf8');
  } catch {
    return null;
  }
}

function decodePanicCode(hex: string): number {
  try {
    return parseInt(hex.slice(10), 16);
  } catch {
    return -1;
  }
}
