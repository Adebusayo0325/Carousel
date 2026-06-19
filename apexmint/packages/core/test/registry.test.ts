import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainRegistry } from '../src/registry.js';
import { isErr, isOk } from '../src/result.js';
import type { ChainAdapter, ChainPlugin } from '../src/chain.js';

function fakePlugin(key: string): ChainPlugin {
  return {
    descriptor: {
      key,
      family: 'evm',
      chainId: 1,
      displayName: key,
      nativeCurrency: { symbol: 'ETH', decimals: 18 },
      defaultRpcUrls: ['https://example.invalid'],
      supportsBundles: false,
      testnet: false,
    },
    create: () => ({ descriptor: { key } } as unknown as ChainAdapter),
  };
}

test('register + adapter build works', () => {
  const reg = new ChainRegistry().register(fakePlugin('ethereum'));
  assert.equal(reg.has('ethereum'), true);
  const a = reg.adapter('ethereum', { rpcUrls: ['https://x.invalid'] });
  assert.ok(isOk(a));
});

test('duplicate registration throws loudly', () => {
  const reg = new ChainRegistry().register(fakePlugin('base'));
  assert.throws(() => reg.register(fakePlugin('base')), /already registered/);
});

test('unknown chain returns not_found, not a throw', () => {
  const reg = new ChainRegistry();
  const d = reg.descriptor('zora');
  assert.ok(isErr(d));
  if (isErr(d)) assert.equal(d.error.code, 'UNKNOWN_CHAIN');
});

test('empty rpc list is rejected', () => {
  const reg = new ChainRegistry().register(fakePlugin('arbitrum'));
  const a = reg.adapter('arbitrum', { rpcUrls: [] });
  assert.ok(isErr(a));
  if (isErr(a)) assert.equal(a.error.code, 'NO_RPC');
});

test('descriptors() lists all registered chains', () => {
  const reg = new ChainRegistry().registerAll([fakePlugin('op'), fakePlugin('linea')]);
  const keys = reg.descriptors().map((d) => d.key).sort();
  assert.deepEqual(keys, ['linea', 'op']);
});
