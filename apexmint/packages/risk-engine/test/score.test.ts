import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, defaultRiskConfig, type RiskFacts } from '../src/index.js';

/** A clean, well-behaved collection: renounced, verified, immutable, sellable. */
const SAFE: RiskFacts = {
  ownershipRenounced: true,
  proxyKind: 'none',
  sourceVerified: true,
  simulatedSellSucceeded: true,
  metadataMutable: false,
  hasSecondaryLiquidity: true,
  supplyMutable: false,
};

test('a clean collection scores low and is not blocked', () => {
  const r = assessRisk(SAFE);
  assert.equal(r.band, 'low');
  assert.ok(r.score < 20, `expected low score, got ${r.score}`);
  assert.equal(r.blocked, false);
});

test('honeypot (sell fails) hard-blocks even with all mitigations', () => {
  const r = assessRisk({ ...SAFE, simulatedSellSucceeded: false });
  assert.ok(r.contributions.some((c) => c.signal === 'honeypot' && c.points > 0));
  // Even maximally "safe" surrounding facts cannot un-block a confirmed honeypot.
  assert.ok(r.hardBlocks.includes('honeypot'));
  assert.equal(r.blocked, true);
});

test('full rug stack scores critical and blocks', () => {
  const rugged: RiskFacts = {
    ownershipRenounced: false,
    ownerIsEoa: true,
    proxyKind: 'uups',
    recentlyUpgraded: true,
    hasArbitraryWithdraw: true,
    hasBlacklist: true,
    hasTradingRestriction: true,
    hasMintPause: true,
    supplyMutable: true,
    hasOwnerMint: true,
    metadataMutable: true,
    simulatedSellSucceeded: false,
    sellTaxBps: 3000,
    sourceVerified: false,
    deployerAgeDays: 1,
    hasSecondaryLiquidity: false,
  };
  const r = assessRisk(rugged);
  assert.equal(r.score, 100); // clamps
  assert.equal(r.band, 'critical');
  assert.equal(r.blocked, true);
});

test('score never exceeds 100 nor drops below 0', () => {
  const allMitigations: RiskFacts = {
    ownershipRenounced: true,
    sourceVerified: true,
    simulatedSellSucceeded: true,
    metadataMutable: false,
    proxyKind: 'none',
  };
  const r = assessRisk(allMitigations);
  assert.ok(r.score >= 0);
  assert.ok(r.score <= 100);
});

// A NEUTRAL base that carries mild risk (well above the 0 floor) so single-signal
// effects are measurable rather than being clamped away.
const NEUTRAL: RiskFacts = {
  proxyKind: 'transparent',
  recentlyUpgraded: true,
  hasMintPause: true,
  simulatedSellSucceeded: true,
};

test('renounced ownership mitigates vs. active EOA owner', () => {
  const eoa = assessRisk({ ...NEUTRAL, ownerIsEoa: true });
  const renounced = assessRisk({ ...NEUTRAL, ownershipRenounced: true });
  assert.ok(renounced.score < eoa.score, `${renounced.score} < ${eoa.score}`);
});

test('timelock owner is safer than EOA owner', () => {
  const eoa = assessRisk({ ...NEUTRAL, ownershipRenounced: false, ownerIsEoa: true });
  const timelock = assessRisk({ ...NEUTRAL, ownershipRenounced: false, ownerIsTimelock: true });
  assert.ok(timelock.score < eoa.score, `${timelock.score} < ${eoa.score}`);
});

test('unverified source adds risk vs verified', () => {
  const verified = assessRisk({ ...NEUTRAL, sourceVerified: true });
  const unverified = assessRisk({ ...NEUTRAL, sourceVerified: false });
  assert.ok(unverified.score > verified.score, `${unverified.score} > ${verified.score}`);
});

test('upgradeable proxy adds risk over a non-proxy', () => {
  const plain = assessRisk({ ...NEUTRAL, proxyKind: 'none', recentlyUpgraded: false });
  const upgradeable = assessRisk({ ...NEUTRAL, proxyKind: 'transparent', recentlyUpgraded: false });
  assert.ok(upgradeable.score > plain.score, `${upgradeable.score} > ${plain.score}`);
});

test('missing data is treated as uncertainty, not safety', () => {
  // Empty facts: sell unknown, metadata unknown, no mitigations.
  const r = assessRisk({});
  assert.ok(r.score > 0, 'no-data should carry some risk, not zero');
});

test('every contribution has a human-readable reason (explainability)', () => {
  const r = assessRisk({ ...SAFE, hasArbitraryWithdraw: true });
  for (const c of r.contributions) {
    assert.ok(c.reason.length > 0);
    assert.ok(c.signal.length > 0);
  }
  assert.ok(r.contributions.some((c) => c.signal === 'withdraw'));
});

test('block threshold is configurable (for non-hard-block risk)', () => {
  // Use a moderate-risk, NON-honeypot collection so only the score threshold
  // governs blocking (hard-blocks would override it).
  const facts: RiskFacts = {
    simulatedSellSucceeded: true,
    ownerIsEoa: true,
    proxyKind: 'transparent',
    sourceVerified: false,
  };
  const score = assessRisk(facts).score;
  assert.ok(score > 10 && score < 99, `expected mid-range score, got ${score}`);
  const strict = assessRisk(facts, { blockThreshold: 10 });
  const lax = assessRisk(facts, { blockThreshold: 99 });
  assert.equal(strict.blocked, true);
  assert.equal(lax.blocked, false);
  assert.equal(defaultRiskConfig().blockThreshold, 70);
});
