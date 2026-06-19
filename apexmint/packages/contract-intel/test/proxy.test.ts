import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectProxy,
  EIP1967_IMPLEMENTATION_SLOT,
  EIP1967_BEACON_SLOT,
  EIP1967_ADMIN_SLOT,
  type SlotReader,
} from '../src/proxy.js';

// These published constants are the authority for EIP-1967. If our keccak were
// wrong, these would not match — so this doubles as a keccak correctness proof.
test('EIP-1967 slot constants match the published values', () => {
  assert.equal(
    EIP1967_IMPLEMENTATION_SLOT,
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  );
  assert.equal(
    EIP1967_BEACON_SLOT,
    '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  );
  assert.equal(
    EIP1967_ADMIN_SLOT,
    '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  );
});

const zero = '0x' + '00'.repeat(32);
const addrSlot = (addr: string) => '0x' + addr.replace(/^0x/, '').padStart(64, '0');

function readerFrom(slots: Record<string, string>): SlotReader {
  return async (slot) => slots[slot] ?? zero;
}

test('detects a transparent proxy (impl + admin populated)', async () => {
  const reader = readerFrom({
    [EIP1967_IMPLEMENTATION_SLOT]: addrSlot('0x1111111111111111111111111111111111111111'),
    [EIP1967_ADMIN_SLOT]: addrSlot('0x2222222222222222222222222222222222222222'),
  });
  const r = await detectProxy({ readSlot: reader, bytecode: '0x6080' });
  assert.equal(r.kind, 'transparent');
  assert.equal(r.implementation, '0x1111111111111111111111111111111111111111');
  assert.equal(r.admin, '0x2222222222222222222222222222222222222222');
});

test('detects UUPS when proxiableUUID selector present', async () => {
  const reader = readerFrom({
    [EIP1967_IMPLEMENTATION_SLOT]: addrSlot('0x3333333333333333333333333333333333333333'),
  });
  // Bytecode contains the proxiableUUID() selector 52d1902d.
  const r = await detectProxy({ readSlot: reader, bytecode: '0x6352d1902d600052' });
  assert.equal(r.kind, 'uups');
  assert.equal(r.implementation, '0x3333333333333333333333333333333333333333');
});

test('detects a beacon proxy', async () => {
  const reader = readerFrom({
    [EIP1967_BEACON_SLOT]: addrSlot('0x4444444444444444444444444444444444444444'),
  });
  const r = await detectProxy({ readSlot: reader, bytecode: '0x' });
  assert.equal(r.kind, 'beacon');
  assert.equal(r.beacon, '0x4444444444444444444444444444444444444444');
});

test('plain EIP-1967 (impl only, no admin, no UUPS marker)', async () => {
  const reader = readerFrom({
    [EIP1967_IMPLEMENTATION_SLOT]: addrSlot('0x5555555555555555555555555555555555555555'),
  });
  const r = await detectProxy({ readSlot: reader, bytecode: '0x6080' });
  assert.equal(r.kind, 'eip1967');
});

test('detects EIP-1167 minimal proxy from bytecode', async () => {
  const impl = 'abababababababababababababababababababab';
  const bytecode =
    '0x363d3d373d3d3d363d73' + impl + '5af43d82803e903d91602b57fd5bf3';
  const r = await detectProxy({ readSlot: readerFrom({}), bytecode });
  assert.equal(r.kind, 'eip1967');
  assert.equal(r.implementation, '0x' + impl);
});

test('non-proxy contract returns none', async () => {
  const r = await detectProxy({ readSlot: readerFrom({}), bytecode: '0x6080604052' });
  assert.equal(r.kind, 'none');
  assert.equal(r.implementation, null);
});
