// packages/core/src/contract/antibotDetector.ts
// Detects antibot patterns on NFT contracts and NOTIFIES users.
// This module NEVER tries to circumvent protections — it informs users
// so they can mint manually when a project has chosen to require it.

import { ethers } from 'ethers';
import { withFailover } from '../rpc/rpcManager.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AntibotSignal =
  | 'SIGNATURE_REQUIRED'      // EIP-712 sig from project's backend (OpenSea/SeaDrop pattern)
  | 'ALLOWLIST_ONLY'          // Merkle proof required — must be on list
  | 'COMMIT_REVEAL'           // Two-step commit-reveal pattern
  | 'POW_PUZZLE'              // On-chain proof-of-work
  | 'LIMIT_BREAK_ANTIBOT'     // Limit Break's DigiDaigaku-style bot protection
  | 'OPENSEA_SEADROP'         // OpenSea SeaDrop (requires OS signature)
  | 'CUSTOM_VALIDATOR'        // Unknown validator pattern
  | 'RATE_LIMITER'            // Per-block mint limits
  | 'COOLDOWN_PERIOD'         // Time-based cooldown between mints
  | 'CAPTCHA_GATE';           // Off-chain captcha required before tx

export interface AntibotDetectionResult {
  detected: boolean;
  signals: AntibotSignal[];
  severity: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  canAutomate: boolean;          // false = project explicitly chose to block bots
  requiresManualMint: boolean;   // true = user should mint via project's website
  notifications: string[];       // Human-readable messages shown to the user
  technicalDetails: string[];    // Dev-level detail for the audit log
}

// ─────────────────────────────────────────────────────────────────────────────
// Known contract addresses / patterns
// ─────────────────────────────────────────────────────────────────────────────

// SeaDrop — requires an off-chain signature from OpenSea's backend
const SEADROP_ABI = [
  'function mintPublic(address,address,address,tuple(uint256,uint256,uint256,uint256,uint16,uint16,bool)) payable',
  'function mintSigned(address,address,address,uint256,tuple(uint256,uint256,uint256,uint256,uint16,uint16,bool),tuple(uint256,bytes)) payable',
];
const SEADROP_SELECTOR = '0xefef39a1'; // mintPublic(...)
const SEADROP_SIGNED_SELECTOR = '0xf1000000'; // mintSigned prefix

// Limit Break / DigiDaigaku — on-chain validator
const LIMIT_BREAK_VALIDATOR_BYTECODE_FRAGMENT = '5f3512'; // characteristic opcode pattern

// Common commit-reveal selectors
const COMMIT_SELECTORS = new Set([
  '0xa40a045e', // commit(bytes32)
  '0xf6010e14', // commitToMint(bytes32)
  '0x8e1a55fc', // commitMint()
]);

// ─────────────────────────────────────────────────────────────────────────────
// Detection logic
// ─────────────────────────────────────────────────────────────────────────────

const DETECTION_ABI = [
  // Signature / allowlist patterns
  'function mintSigned(address,uint256,uint256,uint256,uint256,address,bytes) payable',
  'function mintWithSignature(uint256,bytes) payable',
  'function mintAllowlist(uint256,bytes32[]) payable',
  'function isAllowlistActive() view returns (bool)',
  'function getAllowlistMerkleRoot() view returns (bytes32)',
  'function merkleRoot() view returns (bytes32)',
  // Commit-reveal
  'function commit(bytes32) external',
  'function commitToMint(bytes32) external',
  'function reveal(bytes32) external',
  // Rate limiting
  'function mintedPerBlock(uint256) view returns (uint256)',
  'function maxPerBlock() view returns (uint256)',
  'function lastMintBlock(address) view returns (uint256)',
  'function mintCooldown() view returns (uint256)',
  // Validators
  'function setBotProtection(bool) external',
  'function botProtectionEnabled() view returns (bool)',
];

async function probeSignals(
  contractAddress: string,
  chainId: number,
  abiJson: ethers.JsonFragment[] | null,
): Promise<AntibotSignal[]> {
  const signals: AntibotSignal[] = [];

  if (!abiJson || !Array.isArray(abiJson)) return signals;

  const fns = abiJson.filter(f => f.type === 'function').map(f => ({
    name: (f.name ?? '').toLowerCase(),
    inputs: f.inputs ?? [],
    stateMutability: f.stateMutability ?? '',
  }));

  const fnNames = new Set(fns.map(f => f.name));
  const hasInput = (name: string, type: string) =>
    fns.find(f => f.name === name)?.inputs.some((i: {type: string}) => i.type.includes(type));

  // ── SeaDrop / OS signature requirement ───────────────────────────────────
  if (fnNames.has('mintsigned') && hasInput('mintsigned', 'bytes')) {
    const iface = new ethers.Interface(abiJson);
    const mintSignedFn = iface.getFunction('mintSigned');
    if (mintSignedFn?.selector === SEADROP_SELECTOR ||
        (mintSignedFn?.inputs.length ?? 0) >= 6) {
      signals.push('OPENSEA_SEADROP');
    } else {
      signals.push('SIGNATURE_REQUIRED');
    }
  }

  // ── Generic signature gate ────────────────────────────────────────────────
  if (
    fnNames.has('mintwithsignature') ||
    fns.some(f => f.inputs.some((i: {type: string; name?: string}) =>
      i.type === 'bytes' && (i.name ?? '').toLowerCase().includes('sig'),
    ))
  ) {
    if (!signals.includes('OPENSEA_SEADROP')) signals.push('SIGNATURE_REQUIRED');
  }

  // ── Allowlist-only phase ──────────────────────────────────────────────────
  if (fnNames.has('merkleroot') || fnNames.has('getallowlistmerkleroot')) {
    // Check if public mint function also exists
    const hasPublic = fns.some(f =>
      ['mint', 'publicmint', 'mintpublic'].includes(f.name) &&
      f.stateMutability === 'payable' &&
      !f.inputs.some((i: {type: string}) => i.type.startsWith('bytes32')),
    );
    if (!hasPublic) signals.push('ALLOWLIST_ONLY');
  }

  // ── Commit-reveal ─────────────────────────────────────────────────────────
  if (fnNames.has('commit') || fnNames.has('committomint') || fnNames.has('reveal')) {
    signals.push('COMMIT_REVEAL');
  }

  // ── Per-block rate limiter ────────────────────────────────────────────────
  if (fnNames.has('maxperblock') || fnNames.has('mintedperblock')) {
    signals.push('RATE_LIMITER');
  }

  // ── Cooldown period ───────────────────────────────────────────────────────
  if (fnNames.has('mintcooldown') || fnNames.has('lastmintblock')) {
    signals.push('COOLDOWN_PERIOD');
  }

  // ── Explicit bot protection flag ──────────────────────────────────────────
  if (fnNames.has('botprotectionenabled') || fnNames.has('setbotprotection')) {
    // Check if currently enabled
    const enabled = await withFailover(chainId, async (provider) => {
      try {
        const c = new ethers.Contract(contractAddress, DETECTION_ABI, provider);
        return await c.botProtectionEnabled() as boolean;
      } catch { return false; }
    }).catch(() => false);

    if (enabled) signals.push('CUSTOM_VALIDATOR');
  }

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime check — detect revert patterns from a dry-run
// ─────────────────────────────────────────────────────────────────────────────

export function detectAntibotFromRevert(revertMessage: string): AntibotSignal | null {
  const m = revertMessage.toLowerCase();

  if (m.includes('invalid signature') || m.includes('ecdsa') || m.includes('signature expired'))
    return 'SIGNATURE_REQUIRED';
  if (m.includes('not allowlisted') || m.includes('invalid proof') || m.includes('merkle'))
    return 'ALLOWLIST_ONLY';
  if (m.includes('commit') && (m.includes('first') || m.includes('required')))
    return 'COMMIT_REVEAL';
  if (m.includes('bot') || m.includes('protection') || m.includes('puzzle'))
    return 'CUSTOM_VALIDATOR';
  if (m.includes('cooldown') || m.includes('too soon') || m.includes('wait'))
    return 'COOLDOWN_PERIOD';
  if (m.includes('block limit') || m.includes('per block'))
    return 'RATE_LIMITER';

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry: full antibot detection report
// ─────────────────────────────────────────────────────────────────────────────

const SIGNAL_MESSAGES: Record<AntibotSignal, { user: string; tech: string; severity: number }> = {
  OPENSEA_SEADROP: {
    user: '⚠️ This is an OpenSea SeaDrop contract. It requires an off-chain signature from OpenSea\'s API before each mint. Automated minting is not possible — please mint through the official project website or OpenSea.',
    tech: 'SeaDrop mintSigned() detected — requires OS-backend EIP-712 signature per wallet',
    severity: 3,
  },
  SIGNATURE_REQUIRED: {
    user: '⚠️ This contract requires a unique cryptographic signature from the project\'s server for each mint. The project has chosen to require this verification. Please mint through the official website to obtain your signature.',
    tech: 'EIP-712 / ECDSA signature-gated mint function detected',
    severity: 3,
  },
  ALLOWLIST_ONLY: {
    user: 'ℹ️ This contract is currently in allowlist-only phase. Only wallets on the merkle tree can mint. If your wallet is on the list, ApexMint will retrieve your proof automatically if an API URL is provided. If not, you\'re not eligible to mint in this phase.',
    tech: 'Merkle proof required — no gasless public mint function found',
    severity: 1, // Not truly antibot — legitimate allowlist
  },
  COMMIT_REVEAL: {
    user: '⚠️ This contract uses a commit-reveal scheme (two-step minting). Step 1 commits your intent; Step 2 reveals. Automated two-step minting is not currently supported. Please mint manually through the project site.',
    tech: 'commit()/reveal() pattern detected — two-step anti-sniping mechanism',
    severity: 2,
  },
  POW_PUZZLE: {
    user: '⚠️ This contract requires solving an on-chain proof-of-work puzzle before minting. This is a strong antibot measure the project has deliberately chosen. Please mint manually.',
    tech: 'On-chain PoW challenge detected in calldata',
    severity: 3,
  },
  LIMIT_BREAK_ANTIBOT: {
    user: '⚠️ This contract uses Limit Break\'s advanced bot protection. Automated minting is blocked by the project. Please mint through the official website.',
    tech: 'Limit Break validator pattern in deployed bytecode',
    severity: 3,
  },
  CUSTOM_VALIDATOR: {
    user: '⚠️ This contract has an active bot protection mechanism. The project has explicitly enabled antibot features. Please mint through the official project website.',
    tech: 'botProtectionEnabled() = true, or custom validator pattern detected',
    severity: 3,
  },
  RATE_LIMITER: {
    user: 'ℹ️ This contract limits mints per block. ApexMint will respect this limit. If the block rate is very low, some wallets may need to mint in separate blocks.',
    tech: 'maxPerBlock() or mintedPerBlock() detected',
    severity: 1,
  },
  COOLDOWN_PERIOD: {
    user: 'ℹ️ This contract enforces a cooldown period between mints per wallet. The scheduler will automatically respect these timing constraints.',
    tech: 'mintCooldown() or lastMintBlock() detected',
    severity: 1,
  },
  CAPTCHA_GATE: {
    user: '⚠️ This project requires completing a CAPTCHA before minting. This can only be completed in a browser. Please mint through the official project website.',
    tech: 'CAPTCHA gate detected (off-chain challenge, not on-chain verifiable)',
    severity: 3,
  },
};

export async function detectAntibot(
  contractAddress: string,
  chainId: number,
  abiJson: ethers.JsonFragment[] | null = null,
): Promise<AntibotDetectionResult> {
  const signals = await probeSignals(contractAddress, chainId, abiJson);

  if (signals.length === 0) {
    return {
      detected: false,
      signals: [],
      severity: 'NONE',
      canAutomate: true,
      requiresManualMint: false,
      notifications: [],
      technicalDetails: [],
    };
  }

  const maxSeverity = signals.reduce((max, s) => Math.max(max, SIGNAL_MESSAGES[s]?.severity ?? 0), 0);
  const severity =
    maxSeverity >= 3 ? 'HIGH' :
    maxSeverity === 2 ? 'MEDIUM' :
    'LOW';

  // HIGH severity signals mean the project explicitly blocked automation
  const requiresManual = severity === 'HIGH' || severity === 'MEDIUM';
  const canAutomate = !requiresManual;

  const notifications = signals.map(s => SIGNAL_MESSAGES[s]?.user ?? `Unknown signal: ${s}`);
  const technicalDetails = signals.map(s => SIGNAL_MESSAGES[s]?.tech ?? s);

  // Add a top-level summary for HIGH severity
  if (requiresManual) {
    notifications.unshift(
      `🚫 ApexMint has detected that this project has chosen to restrict automated minting. ` +
      `Out of respect for the project's decision, automated minting will not proceed. ` +
      `Please mint manually through the official website.`,
    );
  }

  return {
    detected: true,
    signals,
    severity,
    canAutomate,
    requiresManualMint: requiresManual,
    notifications,
    technicalDetails,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-mint hook: integrate into mint engine
// ─────────────────────────────────────────────────────────────────────────────

export async function assertCanAutomate(
  contractAddress: string,
  chainId: number,
  abiJson: ethers.JsonFragment[] | null,
): Promise<void> {
  const result = await detectAntibot(contractAddress, chainId, abiJson);

  if (!result.canAutomate) {
    const err = Object.assign(
      new Error(
        `This project has antibot protection active.\n\n` +
        result.notifications.join('\n\n'),
      ),
      {
        code: 'ANTIBOT_DETECTED',
        signals: result.signals,
        severity: result.severity,
        requiresManualMint: true,
      },
    );
    throw err;
  }
}
