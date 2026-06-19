/**
 * Proxy contract detection.
 *
 * Requirement: "Proxy contract detection (EIP-1967, Beacon, UUPS)".
 *
 * We expose:
 *   • The canonical storage-slot constants, COMPUTED from keccak (not pasted),
 *     so they are self-verifying against the EIP.
 *   • `detectProxyFromStorage`: given a reader that can fetch a 32-byte storage
 *     slot and a contract's bytecode, classify the proxy pattern and resolve the
 *     implementation address.
 *
 * The storage reader is injected (a `SlotReader`) so this module has no RPC
 * dependency and is deterministically testable with a fake chain state.
 */

import { keccak256Hex } from './keccak.js';

export type ProxyKind = 'none' | 'eip1967' | 'beacon' | 'uups' | 'transparent' | 'unknown-proxy';

/** keccak256("eip1967.proxy.implementation") - 1 */
export const EIP1967_IMPLEMENTATION_SLOT = subOne(keccak256Hex('eip1967.proxy.implementation'));
/** keccak256("eip1967.proxy.beacon") - 1 */
export const EIP1967_BEACON_SLOT = subOne(keccak256Hex('eip1967.proxy.beacon'));
/** keccak256("eip1967.proxy.admin") - 1 */
export const EIP1967_ADMIN_SLOT = subOne(keccak256Hex('eip1967.proxy.admin'));

function subOne(hex: string): string {
  return '0x' + (BigInt(hex) - 1n).toString(16).padStart(64, '0');
}

const ZERO_SLOT = '0x' + '00'.repeat(32);

/** Reads a single 32-byte storage slot (hex) for a contract. */
export type SlotReader = (slot: string) => Promise<string>;

export interface ProxyDetection {
  readonly kind: ProxyKind;
  /** Resolved implementation address (lowercased, 0x...) if found. */
  readonly implementation: string | null;
  /** Beacon address for beacon proxies. */
  readonly beacon: string | null;
  /** Admin address (transparent proxies). */
  readonly admin: string | null;
  /** Evidence strings for audit/logging (no sensitive data). */
  readonly evidence: readonly string[];
}

function slotToAddress(slot: string): string | null {
  // An address-bearing slot is right-aligned: last 20 bytes.
  const clean = slot.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const addrHex = clean.slice(24); // 64 - 40
  if (/^0+$/.test(addrHex)) return null;
  return '0x' + addrHex;
}

/**
 * Whether bytecode contains the UUPS hallmark: a `proxiableUUID()` function
 * (selector 0x52d1902d) implemented in the *implementation*. Presence of the
 * selector in runtime bytecode is a strong UUPS signal.
 */
const PROXIABLE_UUID_SELECTOR = '52d1902d';

/** Minimal-proxy (EIP-1167) runtime prefix; the impl address is embedded. */
const EIP1167_PREFIX = '363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

export interface DetectInput {
  readonly readSlot: SlotReader;
  /** Runtime bytecode hex (0x...), if available. Empty string if unknown. */
  readonly bytecode: string;
}

export async function detectProxy(input: DetectInput): Promise<ProxyDetection> {
  const evidence: string[] = [];
  const code = input.bytecode.toLowerCase();

  // 1. EIP-1167 minimal proxy — implementation is literally in the bytecode.
  const minimal = detectMinimalProxy(code);
  if (minimal) {
    evidence.push('matched EIP-1167 minimal-proxy bytecode pattern');
    return {
      kind: 'eip1967',
      implementation: minimal,
      beacon: null,
      admin: null,
      evidence,
    };
  }

  // 2. EIP-1967 slots.
  const implSlot = await input.readSlot(EIP1967_IMPLEMENTATION_SLOT);
  const impl = slotToAddress(implSlot);
  const beaconSlot = await input.readSlot(EIP1967_BEACON_SLOT);
  const beacon = slotToAddress(beaconSlot);
  const adminSlot = await input.readSlot(EIP1967_ADMIN_SLOT);
  const admin = slotToAddress(adminSlot);

  if (beacon) {
    evidence.push('EIP-1967 beacon slot populated');
    return { kind: 'beacon', implementation: impl, beacon, admin, evidence };
  }

  if (impl) {
    evidence.push('EIP-1967 implementation slot populated');
    const isUups = code.includes(PROXIABLE_UUID_SELECTOR);
    if (isUups) {
      evidence.push('proxiableUUID() selector present (UUPS)');
      return { kind: 'uups', implementation: impl, beacon: null, admin, evidence };
    }
    if (admin) {
      evidence.push('EIP-1967 admin slot populated (transparent)');
      return { kind: 'transparent', implementation: impl, beacon: null, admin, evidence };
    }
    return { kind: 'eip1967', implementation: impl, beacon: null, admin, evidence };
  }

  // 3. Code hints at a proxy but no standard slot resolved.
  if (code.includes('delegatecall') || code.includes(PROXIABLE_UUID_SELECTOR)) {
    // `delegatecall` opcode is 0xf4; we look at the assembled mnemonic only when
    // a disassembly is provided. As a heuristic we treat the proxiable selector
    // alone as "unknown proxy" rather than a confident classification.
    if (code.includes(PROXIABLE_UUID_SELECTOR)) {
      evidence.push('proxiableUUID() present but no populated impl slot');
      return { kind: 'unknown-proxy', implementation: null, beacon: null, admin, evidence };
    }
  }

  void ZERO_SLOT;
  return { kind: 'none', implementation: null, beacon: null, admin: null, evidence };
}

function detectMinimalProxy(code: string): string | null {
  const hex = code.replace(/^0x/, '');
  const start = hex.indexOf(EIP1167_PREFIX);
  if (start === -1) return null;
  const addrStart = start + EIP1167_PREFIX.length;
  const addrHex = hex.slice(addrStart, addrStart + 40);
  if (addrHex.length !== 40) return null;
  if (!hex.slice(addrStart + 40).startsWith(EIP1167_SUFFIX)) return null;
  if (/^0+$/.test(addrHex)) return null;
  return '0x' + addrHex;
}
