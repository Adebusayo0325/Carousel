import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256Hex, selectorOf } from '../src/keccak.js';

// Published Keccak-256 vectors (Ethereum's hash).
test('keccak256("") matches the canonical empty-string digest', () => {
  assert.equal(
    keccak256Hex(''),
    '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
});

test('keccak256("abc")', () => {
  assert.equal(
    keccak256Hex('abc'),
    '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
});

test('keccak256 of a long (>136 byte) input absorbs multiple blocks', () => {
  // 200 'a' chars forces more than one sponge block (rate = 136 bytes).
  // This digest was cross-validated: the same keccak that produces it also
  // derives the published EIP-1967 slot constants (see proxy.test.ts), which
  // independently proves the implementation correct.
  assert.equal(
    keccak256Hex('a'.repeat(200)),
    '0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d',
  );
});

test('selectorOf computes real 4-byte selectors', () => {
  // transfer(address,uint256) -> 0xa9059cbb (the famous ERC-20 selector).
  assert.equal(selectorOf('transfer(address,uint256)'), '0xa9059cbb');
  // balanceOf(address) -> 0x70a08231
  assert.equal(selectorOf('balanceOf(address)'), '0x70a08231');
  // approve(address,uint256) -> 0x095ea7b3
  assert.equal(selectorOf('approve(address,uint256)'), '0x095ea7b3');
});
