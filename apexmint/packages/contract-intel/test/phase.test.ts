import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferPhase, inferMintParams } from '../src/phase.js';

const T = 1_700_000_000; // arbitrary "now" in unix seconds

test('paused short-circuits everything', () => {
  const r = inferPhase({ now: T, paused: true, publicStart: T - 100 });
  assert.equal(r.phase, 'paused');
  assert.equal(r.publicMintable, false);
});

test('supply exhausted => ended', () => {
  const r = inferPhase({ now: T, totalSupply: 1000, maxSupply: 1000, publicStart: T - 100 });
  assert.equal(r.phase, 'ended');
});

test('within public window => public + mintable', () => {
  const r = inferPhase({ now: T, publicStart: T - 50, publicEnd: T + 50 });
  assert.equal(r.phase, 'public');
  assert.equal(r.publicMintable, true);
});

test('before public start => pre, with countdown', () => {
  const r = inferPhase({ now: T, publicStart: T + 300 });
  assert.equal(r.phase, 'pre');
  assert.equal(r.publicMintable, false);
  assert.equal(r.secondsUntilNext, 300);
});

test('allowlist live before public => allowlist, public not mintable', () => {
  const r = inferPhase({
    now: T,
    allowlistStart: T - 100,
    allowlistEnd: T + 100,
    publicStart: T + 200,
  });
  assert.equal(r.phase, 'allowlist');
  assert.equal(r.publicMintable, false);
  assert.equal(r.secondsUntilNext, 200);
});

test('past public end => ended', () => {
  const r = inferPhase({ now: T, publicStart: T - 1000, publicEnd: T - 1 });
  assert.equal(r.phase, 'ended');
});

test('insufficient data => unknown', () => {
  const r = inferPhase({ now: T });
  assert.equal(r.phase, 'unknown');
});

test('inferMintParams computes remaining supply and defaults', () => {
  const p = inferMintParams({ priceRaw: '50000000000000000', maxPerWallet: 3, totalSupply: 10, maxSupply: 100 });
  assert.equal(p.unitPriceRaw, '50000000000000000');
  assert.equal(p.maxPerWallet, 3);
  assert.equal(p.remainingSupply, 90);

  const free = inferMintParams({});
  assert.equal(free.unitPriceRaw, '0');
  assert.equal(free.maxPerWallet, null);
  assert.equal(free.remainingSupply, null);
});
