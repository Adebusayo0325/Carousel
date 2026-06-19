import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRevert } from '../src/revert.js';
import { selectorOf } from '../src/keccak.js';

/** ABI-encode an Error(string) revert payload. */
function errorString(msg: string): string {
  const selector = '08c379a0';
  const bytes = Buffer.from(msg, 'utf8');
  const offset = (32).toString(16).padStart(64, '0');
  const length = bytes.length.toString(16).padStart(64, '0');
  const data = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
  return '0x' + selector + offset + length + data;
}

test('decodes Error(string) and classifies "sale not active"', () => {
  const r = classifyRevert(errorString('Sale not active'));
  assert.equal(r.category, 'not_started');
  assert.equal(r.action, 'retry_when_live');
  assert.equal(r.retriable, true);
  assert.equal(r.reason, 'Sale not active');
});

test('classifies sold out as terminal abort', () => {
  const r = classifyRevert(errorString('Max supply reached'));
  assert.equal(r.category, 'sold_out');
  assert.equal(r.action, 'abort');
  assert.equal(r.retriable, false);
});

test('classifies underpayment -> retry with higher value', () => {
  const r = classifyRevert(errorString('Insufficient payment'));
  assert.equal(r.category, 'insufficient_payment');
  assert.equal(r.action, 'retry_with_higher_value');
});

test('classifies wallet limit', () => {
  const r = classifyRevert(errorString('Max per wallet exceeded'));
  assert.equal(r.category, 'wallet_limit');
  assert.equal(r.action, 'abort');
});

test('classifies allowlist failure -> needs_allowlist', () => {
  const r = classifyRevert(errorString('Invalid merkle proof'));
  assert.equal(r.category, 'not_allowlisted');
  assert.equal(r.action, 'needs_allowlist');
});

test('decodes Panic(uint256) as arithmetic', () => {
  const panic = '0x4e487b71' + (0x11).toString(16).padStart(64, '0'); // overflow
  const r = classifyRevert(panic);
  assert.equal(r.category, 'arithmetic');
  assert.equal(r.action, 'abort');
});

test('matches custom error selector MintNotActive()', () => {
  const r = classifyRevert(selectorOf('MintNotActive()'));
  assert.equal(r.category, 'not_started');
});

test('matches custom error WalletLimitExceeded()', () => {
  const r = classifyRevert(selectorOf('WalletLimitExceeded()'));
  assert.equal(r.category, 'wallet_limit');
});

test('empty revert is unknown + retriable backoff', () => {
  const r = classifyRevert('0x');
  assert.equal(r.category, 'unknown');
  assert.equal(r.action, 'retry_backoff');
});

test('unknown custom selector falls through to unknown', () => {
  const r = classifyRevert('0xdeadbeef');
  assert.equal(r.category, 'unknown');
  assert.equal(r.selector, '0xdeadbeef');
});
