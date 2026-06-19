import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  featuresForTier,
  isFeatureAllowed,
  resolveGrantedFeatures,
  limitsForTier,
  isTier,
  isFeature,
} from '../src/tiers.js';

test('basic tier is intentionally narrow', () => {
  const f = featuresForTier('basic');
  assert.ok(f.includes('evm-mint'));
  assert.ok(!f.includes('solana'));
  assert.ok(!f.includes('multi-wallet'));
  assert.ok(!f.includes('bundles'));
});

test('premium grants solana + bundles but not white-label', () => {
  assert.equal(isFeatureAllowed('premium', 'solana'), true);
  assert.equal(isFeatureAllowed('premium', 'bundles'), true);
  assert.equal(isFeatureAllowed('premium', 'white-label'), false);
});

test('enterprise grants everything', () => {
  assert.equal(isFeatureAllowed('enterprise', 'white-label'), true);
  assert.equal(isFeatureAllowed('enterprise', 'custom-rpc'), true);
});

test('issued feature list can NARROW but never WIDEN a tier', () => {
  // Basic key that was issued "solana" must still be denied — tier wins.
  assert.equal(isFeatureAllowed('basic', 'solana', ['solana']), false);
  // Premium key issued only evm-mint is denied solana even though tier allows it.
  assert.equal(isFeatureAllowed('premium', 'solana', ['evm-mint']), false);
  assert.equal(isFeatureAllowed('premium', 'evm-mint', ['evm-mint']), true);
});

test('"all" shorthand resolves to the full tier grant set', () => {
  assert.deepEqual(
    resolveGrantedFeatures('premium', ['all']).sort(),
    featuresForTier('premium').sort(),
  );
});

test('resolveGrantedFeatures intersects issued list with tier', () => {
  const granted = resolveGrantedFeatures('premium', ['evm-mint', 'solana', 'white-label']);
  assert.ok(granted.includes('evm-mint'));
  assert.ok(granted.includes('solana'));
  // white-label is not a premium grant, so it is dropped.
  assert.ok(!granted.includes('white-label'));
});

test('limits scale by tier', () => {
  assert.ok(limitsForTier('basic').maxWallets < limitsForTier('premium').maxWallets);
  assert.ok(limitsForTier('premium').maxWallets < limitsForTier('enterprise').maxWallets);
});

test('type guards reject junk', () => {
  assert.equal(isTier('premium'), true);
  assert.equal(isTier('platinum'), false);
  assert.equal(isFeature('solana'), true);
  assert.equal(isFeature('telepathy'), false);
});
