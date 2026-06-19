/**
 * Compact Keccak-256 (the Ethereum hash, pre-NIST-padding).
 *
 * Why ship our own: function-selector computation and the EIP-1967 storage slot
 * constants are *defined* in terms of keccak-256. Rather than hardcode a lookup
 * table of selectors (brittle, unverifiable), we compute them. Bundling a tiny,
 * dependency-free keccak keeps @apexmint/contract-intel pure and lets the tests
 * prove correctness against published constants (e.g. the EIP-1967 slot values).
 *
 * Implementation: Keccak-f[1600] sponge, rate 1088 bits (136 bytes), capacity
 * 512, domain-separation byte 0x01 (Keccak, NOT SHA3's 0x06). BigInt lanes for
 * clarity over micro-optimization — contract intel runs off the hot path.
 */

const RATE_BYTES = 136; // 1088-bit rate for keccak-256
const OUTPUT_BYTES = 32;
const MASK64 = (1n << 64n) - 1n;

const ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROTATION = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

function rotl64(x: bigint, n: number): bigint {
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

function keccakF(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // θ (theta)
    const c = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    const d = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5]! ^ rotl64(c[(x + 1) % 5]!, 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 25; y += 5) {
        state[x + y] = state[x + y]! ^ d[x]!;
      }
    }

    // ρ (rho) + π (pi)
    const b = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const idx = x + 5 * y;
        const newIdx = y + 5 * ((2 * x + 3 * y) % 5);
        b[newIdx] = rotl64(state[idx]!, ROTATION[idx]!);
      }
    }

    // χ (chi)
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        state[x + y] = b[x + y]! ^ (~b[((x + 1) % 5) + y]! & b[((x + 2) % 5) + y]!) & MASK64;
      }
    }

    // ι (iota)
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

/** Keccak-256 of arbitrary bytes. */
export function keccak256(input: Uint8Array): Uint8Array {
  const state = new Array<bigint>(25).fill(0n);

  // Absorb
  const padded = pad(input);
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let i = 0; i < RATE_BYTES / 8; i++) {
      let lane = 0n;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(padded[offset + i * 8 + b]!) << BigInt(8 * b);
      }
      state[i] = state[i]! ^ lane;
    }
    keccakF(state);
  }

  // Squeeze (one block suffices: 32 <= rate)
  const out = new Uint8Array(OUTPUT_BYTES);
  for (let i = 0; i < OUTPUT_BYTES; i++) {
    const lane = state[Math.floor(i / 8)]!;
    out[i] = Number((lane >> BigInt(8 * (i % 8))) & 0xffn);
  }
  return out;
}

function pad(input: Uint8Array): Uint8Array {
  const padLen = RATE_BYTES - (input.length % RATE_BYTES);
  const padded = new Uint8Array(input.length + padLen);
  padded.set(input, 0);
  // Keccak padding: 0x01 ... 0x80 (multi-rate padding "pad10*1").
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1]! | 0x80) & 0xff;
  return padded;
}

const enc = new TextEncoder();

/** Keccak-256 of a UTF-8 string, returned as 0x-prefixed hex. */
export function keccak256Hex(text: string): string {
  return '0x' + Buffer.from(keccak256(enc.encode(text))).toString('hex');
}

/**
 * The 4-byte function selector for a Solidity signature like
 * "mint(uint256)". Returns 0x-prefixed hex (10 chars incl. 0x).
 */
export function selectorOf(signature: string): string {
  return keccak256Hex(signature).slice(0, 10);
}
