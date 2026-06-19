/**
 * Function fingerprinting & dynamic mint discovery.
 *
 * Requirements: "Function fingerprinting for unknown mint contracts", "Dynamic
 * mint function discovery".
 *
 * Strategy:
 *   1. Maintain a catalogue of known mint signatures across the popular NFT
 *      standards/launchpads (ERC-721A, SeaDrop, thirdweb Drop, Zora, Manifold,
 *      ERC-1155). Each entry's 4-byte selector is COMPUTED from its signature.
 *   2. `discoverMintFunctions(bytecode)`: scan a contract's runtime bytecode for
 *      `PUSH4 <selector>` sequences (the standard selector-dispatch pattern) and
 *      match them against the catalogue. This recovers callable mint entrypoints
 *      even when the ABI is unavailable.
 *   3. Rank candidates so the engine routes to the most specific mint function
 *      (fixing the legacy bot's "signature guessing / fragile mintSigned
 *      routing").
 */

import { selectorOf } from './keccak.js';

export interface MintSignature {
  readonly signature: string;
  readonly selector: string;
  /** Launchpad/standard family, for routing + risk context. */
  readonly family: string;
  /** Whether this entrypoint expects an allowlist proof / signature. */
  readonly gated: boolean;
  /** Higher = more specific / preferred when multiple match. */
  readonly priority: number;
}

function sig(signature: string, family: string, gated: boolean, priority: number): MintSignature {
  return { signature, selector: selectorOf(signature), family, gated, priority };
}

/**
 * Catalogue of known mint entrypoints. Selectors are derived, so adding a new
 * launchpad is a one-line signature entry — no manual hex.
 */
export const KNOWN_MINT_SIGNATURES: readonly MintSignature[] = [
  // Public, ungated mints
  sig('mint(uint256)', 'generic', false, 50),
  sig('mint(address,uint256)', 'generic', false, 45),
  sig('publicMint(uint256)', 'generic', false, 60),
  sig('mintPublic(address,uint256)', 'seadrop', false, 65),
  sig('claim(address,uint256)', 'thirdweb', false, 55),
  // ERC-721A style
  sig('mint(uint256,bytes32[])', 'erc721a-allowlist', true, 70),
  // SeaDrop allowlist / signed
  sig(
    'mintAllowList(address,address,address,uint256,(uint256,uint256,uint256,uint256,uint256,uint256,address,uint8)[],bytes32[])',
    'seadrop',
    true,
    80,
  ),
  sig(
    'mintSigned(address,address,address,uint256,(uint256,uint256,uint256,uint256,uint256,uint256,address,uint8)[],bytes)',
    'seadrop',
    true,
    82,
  ),
  // thirdweb Drop with allowlist proof struct
  sig(
    'claim(address,uint256,address,uint256,(bytes32[],uint256,uint256,address),bytes)',
    'thirdweb-drop',
    true,
    78,
  ),
  // Zora fixed-price minter
  sig('mintWithRewards(address,uint256,uint256,bytes,address)', 'zora', false, 72),
  sig('purchase(uint256)', 'zora-legacy', false, 40),
  // Manifold
  sig('mint(address,uint256,uint256,bytes32[],address)', 'manifold', true, 68),
  // ERC-1155
  sig('mint(address,uint256,uint256,bytes)', 'erc1155', false, 48),
];

const SELECTOR_INDEX: ReadonlyMap<string, MintSignature> = new Map(
  KNOWN_MINT_SIGNATURES.map((s) => [s.selector, s]),
);

export interface DiscoveredMint {
  readonly selector: string;
  readonly match: MintSignature | null;
}

/**
 * Extract every 4-byte selector that appears as a `PUSH4` immediate in runtime
 * bytecode. Solidity's dispatcher compares the calldata selector against each
 * function selector via PUSH4; collecting those recovers the function table.
 */
export function extractPush4Selectors(bytecode: string): string[] {
  const hex = bytecode.toLowerCase().replace(/^0x/, '');
  const found = new Set<string>();
  let i = 0;
  while (i + 2 <= hex.length) {
    const op = hex.slice(i, i + 2);
    const opcode = parseInt(op, 16);
    if (Number.isNaN(opcode)) break;
    if (opcode === 0x63) {
      // PUSH4
      const sel = hex.slice(i + 2, i + 10);
      if (sel.length === 8) found.add('0x' + sel);
      i += 10; // skip opcode + 4 bytes
      continue;
    }
    // PUSH1..PUSH32 (0x60..0x7f) carry immediates we must skip over so we don't
    // misread immediate bytes as opcodes.
    if (opcode >= 0x60 && opcode <= 0x7f) {
      const len = opcode - 0x5f;
      i += 2 + len * 2;
      continue;
    }
    i += 2;
  }
  return [...found];
}

/**
 * Discover candidate mint functions in a contract, ranked by priority. Known
 * selectors are annotated with their signature; unknown PUSH4 selectors that
 * match the mint catalogue are surfaced too.
 */
export function discoverMintFunctions(bytecode: string): DiscoveredMint[] {
  const selectors = extractPush4Selectors(bytecode);
  const matched: DiscoveredMint[] = [];
  for (const sel of selectors) {
    const match = SELECTOR_INDEX.get(sel);
    if (match) matched.push({ selector: sel, match });
  }
  matched.sort((a, b) => (b.match?.priority ?? 0) - (a.match?.priority ?? 0));
  return matched;
}

/** Look up a known mint signature by selector. */
export function mintSignatureForSelector(selector: string): MintSignature | null {
  return SELECTOR_INDEX.get(selector.toLowerCase()) ?? null;
}

/**
 * Choose the single best mint entrypoint to route to. Prefers an explicit hint
 * if it matches the catalogue; otherwise the highest-priority discovered fn.
 * Returns null when nothing usable is found (caller must NOT guess — this is the
 * fix for the legacy "signature guessing" footgun).
 */
export function selectMintRoute(bytecode: string, hint?: string): MintSignature | null {
  if (hint) {
    const byHint = mintSignatureForSelector(hint);
    if (byHint) return byHint;
  }
  const discovered = discoverMintFunctions(bytecode);
  return discovered[0]?.match ?? null;
}
