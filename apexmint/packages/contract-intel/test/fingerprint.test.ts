import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_MINT_SIGNATURES,
  extractPush4Selectors,
  discoverMintFunctions,
  selectMintRoute,
  mintSignatureForSelector,
} from '../src/fingerprint.js';
import { selectorOf } from '../src/keccak.js';

test('every catalogue selector is the real keccak of its signature', () => {
  for (const s of KNOWN_MINT_SIGNATURES) {
    assert.equal(s.selector, selectorOf(s.signature), `selector mismatch for ${s.signature}`);
  }
});

test('catalogue selectors are unique', () => {
  const set = new Set(KNOWN_MINT_SIGNATURES.map((s) => s.selector));
  assert.equal(set.size, KNOWN_MINT_SIGNATURES.length);
});

test('extractPush4Selectors skips PUSH immediates correctly', () => {
  // PUSH4 aabbccdd, then PUSH1 63 (0x63 is PUSH4 opcode as DATA, must be skipped)
  const sel = 'aabbccdd';
  const bytecode = '0x63' + sel + '6063'; // PUSH4 <sel>, PUSH1 0x63
  const found = extractPush4Selectors(bytecode);
  assert.deepEqual(found, ['0xaabbccdd']);
  // The 0x63 inside PUSH1's immediate must NOT be read as another PUSH4.
});

test('discoverMintFunctions finds known mints in a selector table', () => {
  const publicMint = selectorOf('publicMint(uint256)');
  const seadrop = selectorOf('mintPublic(address,uint256)');
  // Two PUSH4s in a fake dispatcher.
  const bytecode = '0x63' + publicMint.slice(2) + '63' + seadrop.slice(2);
  const found = discoverMintFunctions(bytecode);
  const sels = found.map((f) => f.selector);
  assert.ok(sels.includes(publicMint));
  assert.ok(sels.includes(seadrop));
  // Highest priority first (mintPublic=65 > publicMint=60).
  assert.equal(found[0]!.selector, seadrop);
});

test('selectMintRoute honors a valid hint over discovery', () => {
  const claim = selectorOf('claim(address,uint256)');
  const bytecode = '0x63' + selectorOf('mint(uint256)').slice(2);
  const route = selectMintRoute(bytecode, claim);
  assert.ok(route);
  assert.equal(route!.selector, claim);
});

test('selectMintRoute returns null when nothing matches (no guessing)', () => {
  // Bytecode with only an unrelated selector.
  const bytecode = '0x63deadbeef';
  assert.equal(selectMintRoute(bytecode), null);
});

test('mintSignatureForSelector lookup', () => {
  const sel = selectorOf('mint(uint256)');
  const sig = mintSignatureForSelector(sel);
  assert.ok(sig);
  assert.equal(sig!.signature, 'mint(uint256)');
  assert.equal(mintSignatureForSelector('0x00000000'), null);
});
