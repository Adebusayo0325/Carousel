// packages/core/src/contract/intelligence.ts
// Automatic ABI recovery, proxy detection (EIP-1967/Beacon/UUPS), function
// fingerprinting, and mint parameter inference.

import { ethers } from 'ethers';
import { withFailover } from '../rpc/rpcManager.js';
import { getChain } from '../chains/registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// ABI fetching from block explorers
// ─────────────────────────────────────────────────────────────────────────────

const _abiCache = new Map<string, ethers.InterfaceAbi | null>();

export async function fetchABI(
  contractAddress: string,
  chainId: number,
): Promise<ethers.InterfaceAbi | null> {
  const key = `${chainId}:${contractAddress.toLowerCase()}`;
  if (_abiCache.has(key)) return _abiCache.get(key)!;

  const chain = getChain(chainId);
  if (!chain.explorerApiUrl) { _abiCache.set(key, null); return null; }

  const apiKey = chain.explorerApiKey ?? '';
  const url = `${chain.explorerApiUrl}?module=contract&action=getabi&address=${contractAddress}&apikey=${apiKey}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const json = await res.json() as { status: string; result: string };
    if (json.status === '1' && json.result && json.result !== 'Contract source code not verified') {
      const abi = JSON.parse(json.result);
      _abiCache.set(key, abi);
      return abi;
    }
  } catch { /* explorer unavailable */ }

  // Try Sourcify as fallback
  try {
    const sourcifyUrl = `https://repo.sourcify.dev/contracts/full_match/${chainId}/${contractAddress}/metadata.json`;
    const res = await fetch(sourcifyUrl, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const meta = await res.json() as { output?: { abi?: ethers.InterfaceAbi } };
      if (meta?.output?.abi) {
        _abiCache.set(key, meta.output.abi);
        return meta.output.abi;
      }
    }
  } catch { /* noop */ }

  _abiCache.set(key, null);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Proxy detection
// ─────────────────────────────────────────────────────────────────────────────

// EIP-1967 implementation slot
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
// EIP-1967 beacon slot
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
// OpenZeppelin Transparent Proxy admin slot
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

export interface ProxyInfo {
  isProxy: boolean;
  proxyType: 'EIP1967' | 'UUPS' | 'Beacon' | 'Transparent' | 'GnosisSafe' | 'Unknown' | 'None';
  implementationAddress?: string;
  beaconAddress?: string;
  adminAddress?: string;
}

export async function detectProxy(
  contractAddress: string,
  chainId: number,
): Promise<ProxyInfo> {
  return withFailover(chainId, async (provider) => {
    // Check EIP-1967 implementation slot
    try {
      const implSlotValue = await provider.getStorage(contractAddress, IMPL_SLOT);
      if (implSlotValue && implSlotValue !== ethers.ZeroHash) {
        const impl = '0x' + implSlotValue.slice(-40);
        if (impl !== ethers.ZeroAddress) {
          return { isProxy: true, proxyType: 'EIP1967', implementationAddress: ethers.getAddress(impl) };
        }
      }
    } catch { /* noop */ }

    // Check Beacon slot
    try {
      const beaconSlotValue = await provider.getStorage(contractAddress, BEACON_SLOT);
      if (beaconSlotValue && beaconSlotValue !== ethers.ZeroHash) {
        const beacon = '0x' + beaconSlotValue.slice(-40);
        if (beacon !== ethers.ZeroAddress) {
          return { isProxy: true, proxyType: 'Beacon', beaconAddress: ethers.getAddress(beacon) };
        }
      }
    } catch { /* noop */ }

    // Check for UUPS via ERC-1822 proxiableUUID
    try {
      const iface = new ethers.Interface(['function proxiableUUID() view returns (bytes32)']);
      const c = new ethers.Contract(contractAddress, iface, provider);
      await c.proxiableUUID();
      return { isProxy: true, proxyType: 'UUPS' };
    } catch { /* noop */ }

    return { isProxy: false, proxyType: 'None' };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Token standard detection
// ─────────────────────────────────────────────────────────────────────────────

const ERC165_ABI = ['function supportsInterface(bytes4 interfaceId) view returns (bool)'];
const ERC1155_INTERFACE_ID = '0xd9b67a26';
const ERC721_INTERFACE_ID = '0x80ac58cd';

export async function detectTokenStandard(
  contractAddress: string,
  chainId: number,
): Promise<'ERC721' | 'ERC1155' | 'UNKNOWN'> {
  return withFailover(chainId, async (provider) => {
    try {
      const c = new ethers.Contract(contractAddress, ERC165_ABI, provider);
      const [is1155, is721] = await Promise.all([
        c.supportsInterface(ERC1155_INTERFACE_ID).catch(() => false),
        c.supportsInterface(ERC721_INTERFACE_ID).catch(() => false),
      ]);
      if (is1155) return 'ERC1155';
      if (is721) return 'ERC721';
    } catch { /* noop */ }
    return 'UNKNOWN';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mint function discovery
// ─────────────────────────────────────────────────────────────────────────────

export const FALLBACK_ABI_721: ethers.InterfaceAbi = [
  'function mint(uint256 quantity) payable',
  'function mint(address to, uint256 quantity) payable',
  'function mint(uint256 quantity, bytes32[] calldata proof) payable',
  'function mint() payable',
  'function mintTo(address to) payable',
  'function publicMint(uint256 quantity) payable',
  'function mintPublic(uint256 quantity) payable',
  'function buy(uint256 quantity) payable',
  'function claim(uint256 quantity) payable',
  'function claim(address account, uint256 quantity, bytes32[] calldata proof) payable',
  'function purchase(uint256 quantity) payable',
  'function allowlistMint(uint256 quantity, bytes32[] calldata proof) payable',
  'function presaleMint(uint256 quantity, bytes32[] calldata proof) payable',
  'function mintWithProof(uint256 quantity, bytes32[] calldata proof) payable',
  'function whitelistMint(uint256 quantity, bytes32[] calldata proof) payable',
  'function mintNFT(uint256 quantity) payable',
  'function freeMint(uint256 quantity) payable',
  'function safeMint(address to, uint256 quantity) payable',
  'function mintSigned(address,uint256,uint256,uint256,uint256,address,bytes) payable',
  'function mint(uint256 quantity, bytes calldata signature) payable',
];

export const FALLBACK_ABI_1155: ethers.InterfaceAbi = [
  'function mint(address account, uint256 id, uint256 amount, bytes data) payable',
  'function mint(uint256 id, uint256 amount) payable',
  'function mint(uint256 tokenId, uint256 quantity) payable',
  'function mintBatch(address to, uint256[] ids, uint256[] amounts, bytes data) payable',
  'function purchase(uint256 tokenId, uint256 quantity) payable',
  'function claim(address account, uint256 tokenId, uint256 quantity, bytes32[] proof) payable',
];

const MINT_FN_PRIORITY: string[] = [
  'publicMint', 'mintPublic', 'mint', 'buy', 'mintNFT',
  'claim', 'purchase', 'allowlistMint', 'presaleMint',
  'mintWithProof', 'whitelistMint', 'freeMint', 'safeMint', 'mintTo',
  'mintSigned', // last — only for signature-gated phases
];

export interface MintFunctionInfo {
  fnName: string;
  inputs: ethers.ParamType[] | null;
  isSignatureGated: boolean;
  hasProof: boolean;
}

export function findBestMintFunction(
  abiJson: ethers.InterfaceAbi,
  standard: 'ERC721' | 'ERC1155',
  hasProof: boolean,
  wantsSigned: boolean,
): MintFunctionInfo | null {
  if (!Array.isArray(abiJson)) return null;

  const priority = standard === 'ERC1155'
    ? ['mint', 'mintBatch', 'purchase', 'claim']
    : MINT_FN_PRIORITY;

  const candidates = (abiJson as ethers.JsonFragment[]).filter(fn => {
    if (fn.type !== 'function') return false;
    if (!['payable', 'nonpayable'].includes(fn.stateMutability ?? '')) return false;
    return priority.some(n => n.toLowerCase() === fn.name?.toLowerCase());
  });

  if (candidates.length === 0) return null;

  const iface = new ethers.Interface(abiJson);

  // Sort by priority; prefer proof-having variants when proof is available
  candidates.sort((a, b) => {
    const ai = priority.findIndex(n => n.toLowerCase() === a.name?.toLowerCase());
    const bi = priority.findIndex(n => n.toLowerCase() === b.name?.toLowerCase());
    const aHasProof = (a.inputs ?? []).some(i => i.type?.startsWith('bytes32') || i.type === 'bytes');
    const bHasProof = (b.inputs ?? []).some(i => i.type?.startsWith('bytes32') || i.type === 'bytes');
    if (hasProof && !wantsSigned) {
      if (aHasProof && !bHasProof) return -1;
      if (!aHasProof && bHasProof) return 1;
    }
    return ai - bi;
  });

  // Critical fix from v26 audit: mintSigned only when explicitly requested or only option
  const nonSignedCandidates = candidates.filter(c => c.name !== 'mintSigned');
  const chosen = wantsSigned
    ? (candidates.find(c => c.name === 'mintSigned') ?? candidates[0])
    : (nonSignedCandidates[0] ?? candidates[0]);

  const fragment = iface.getFunction(chosen.name!);
  if (!fragment) return null;

  return {
    fnName: chosen.name!,
    inputs: Array.from(fragment.inputs),
    isSignatureGated: chosen.name === 'mintSigned' ||
      (chosen.inputs ?? []).some(i => i.type === 'bytes' || i.name?.toLowerCase().includes('sig')),
    hasProof: (chosen.inputs ?? []).some(i => i.type?.startsWith('bytes32')),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mint argument construction
// ─────────────────────────────────────────────────────────────────────────────

export function buildMintArgs(
  inputs: ethers.ParamType[] | null,
  quantity: number,
  walletAddress: string,
  merkleProof: string[] = [],
  tokenId: number = 1,
  eip712Sig: string | null = null,
): unknown[] {
  if (inputs === null) return [quantity];
  if (inputs.length === 0) return [];

  return inputs.map(input => {
    const t = input.type;
    const n = (input.name ?? '').toLowerCase();

    if ((t.startsWith('uint') || t.startsWith('int')) &&
        (n.includes('qty') || n.includes('quantity') || n.includes('amount') ||
         n.includes('count') || n.includes('num') || n === 'n' || n === ''))
      return quantity;
    if ((t.startsWith('uint') || t.startsWith('int')) && n.includes('token')) return tokenId;
    if ((t.startsWith('uint') || t.startsWith('int')) && (n.includes('max') || n.includes('limit'))) return quantity;
    if (t.startsWith('uint') || t.startsWith('int')) return quantity;
    if (t === 'address') return walletAddress;
    if (t === 'bytes32[]' || t.startsWith('bytes32[')) return merkleProof.length > 0 ? merkleProof : [];
    if (t === 'bytes32') return ethers.ZeroHash;
    if (t === 'bytes') return eip712Sig ?? '0x';
    if (t.startsWith('bytes') && t !== 'bytes32') return eip712Sig ?? '0x';
    if (t === 'bool') return false;
    if (t === 'string') return '';
    return 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Revert reason decoder
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_SELECTORS: Record<string, string> = {
  '1469c1bd': 'MintNotActive — mint phase not open yet',
  'b6fee2e9': 'NotAllowListed — wallet not on the allowlist',
  'a5f34628': 'InvalidSignature — signature invalid or already used',
  '34bf3526': 'MaxMintPerWallet — already minted max for this wallet',
  '8e570b63': 'MaxSupplyReached — collection sold out',
  '278a4e0d': 'NotActive — sale not active',
  'd4d30fc3': 'AllowListStageNotActive',
  '6fbde40e': 'Paused — contract is paused',
  '82b42900': 'Unauthorized',
  'e6c4247b': 'InvalidAddress',
};

export function decodeRevertReason(err: unknown, fnName: string): string {
  const e = err as { reason?: string; data?: string; message?: string; info?: { error?: { data?: string } } };
  const msg = e.message ?? String(err);

  if (e.reason) return classifyRevert(e.reason, fnName);

  if (e.data && typeof e.data === 'string' && e.data.startsWith('0x')) {
    const hex = e.data.slice(2);
    if (hex.startsWith('08c379a0')) {
      try {
        const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + hex.slice(8));
        if (decoded) return classifyRevert(decoded as string, fnName);
      } catch { /* noop */ }
    }
    if (hex.startsWith('4e487b71')) return 'Contract panic — internal error';
    const sel = hex.slice(0, 8).toLowerCase();
    if (KNOWN_SELECTORS[sel]) return KNOWN_SELECTORS[sel];
    return `Custom error 0x${sel}`;
  }

  if (e.info?.error?.data) return decodeRevertReason({ data: e.info.error.data, message: msg }, fnName);
  return classifyRevert(msg, fnName);
}

function classifyRevert(msg: string, fnName: string): string {
  const m = msg.toLowerCase();
  if (m.includes('insufficient funds')) return 'Insufficient ETH for mint + gas';
  if (m.includes('nonce')) return 'Nonce error — retry';
  if (m.includes('invalid proof') || m.includes('merkle')) return 'Invalid Merkle proof';
  if (m.includes('invalid signature') || m.includes('ecdsa')) return 'Invalid EIP-712 signature — expired or already used';
  if (m.includes('not whitelisted') || m.includes('not allowlisted') || m.includes('not on allowlist')) return 'Wallet not on allowlist';
  if (m.includes('sale not active') || m.includes('not started') || m.includes('mint closed') ||
      m.includes('not live') || m.includes('mint not open') || m.includes('notactive')) return 'Mint not open — sale not active';
  if (m.includes('sold out') || m.includes('max supply') || m.includes('exceeds max supply')) return 'Collection sold out';
  if (m.includes('max per wallet') || m.includes('already minted max') || m.includes('wallet limit')) return 'Exceeds max per wallet';
  if (m.includes('wrong price') || m.includes('incorrect price') || m.includes('wrong value')) return 'Wrong mint price';
  if (m.includes('paused')) return 'Contract paused';
  return `${fnName}() reverted: ${msg.slice(0, 200)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase detection
// ─────────────────────────────────────────────────────────────────────────────

export interface PhaseInfo {
  phase: 'public' | 'whitelist' | 'paused' | 'soldout' | 'unknown';
  isPublic: boolean;
  isWhitelist: boolean;
  isPaused: boolean;
  isSoldOut: boolean;
  mintPrice?: number;
  maxPerWallet?: number;
  totalSupply?: number;
  maxSupply?: number;
  confidence: 'verified' | 'inferred' | 'unknown';
  reason: string;
}

const PHASE_ABI = [
  'function paused() view returns (bool)',
  'function saleIsActive() view returns (bool)',
  'function publicSaleActive() view returns (bool)',
  'function presaleActive() view returns (bool)',
  'function mintingEnabled() view returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function TOTAL_SUPPLY() view returns (uint256)',
  'function mintPrice() view returns (uint256)',
  'function price() view returns (uint256)',
  'function MINT_PRICE() view returns (uint256)',
  'function cost() view returns (uint256)',
  'function maxMintPerWallet() view returns (uint256)',
  'function maxPerWallet() view returns (uint256)',
  'function walletLimit() view returns (uint256)',
];

export async function detectPhase(
  contractAddress: string,
  chainId: number,
): Promise<PhaseInfo> {
  return withFailover(chainId, async (provider) => {
    const c = new ethers.Contract(contractAddress, PHASE_ABI, provider);

    const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => {
      try { return await fn(); } catch { return null; }
    };

    const [
      paused,
      saleActive,
      publicActive,
      presaleActive,
      mintingEnabled,
      totalSupplyRaw,
      maxSupplyRaw,
      maxSupplyAlt,
      mintPriceRaw,
      priceRaw,
      costRaw,
      maxPerWalletRaw,
    ] = await Promise.all([
      safe(() => c.paused()),
      safe(() => c.saleIsActive()),
      safe(() => c.publicSaleActive()),
      safe(() => c.presaleActive()),
      safe(() => c.mintingEnabled()),
      safe(() => c.totalSupply()),
      safe(() => c.maxSupply()),
      safe(() => c.MAX_SUPPLY()),
      safe(() => c.mintPrice()),
      safe(() => c.price()),
      safe(() => c.cost()),
      safe(() => c.maxPerWallet()),
    ]);

    const isPaused = paused === true;
    const maxSupply = maxSupplyRaw ?? maxSupplyAlt;
    const totalSupply = totalSupplyRaw;
    const isSoldOut = (maxSupply && totalSupply) ? Number(totalSupply) >= Number(maxSupply) : false;

    const priceWei = mintPriceRaw ?? priceRaw ?? costRaw ?? null;
    const mintPrice = priceWei !== null ? parseFloat(ethers.formatEther(BigInt(priceWei.toString()))) : undefined;
    const maxPerWallet = maxPerWalletRaw !== null ? Number(maxPerWalletRaw) : undefined;

    if (isPaused) {
      return { phase: 'paused', isPublic: false, isWhitelist: false, isPaused: true, isSoldOut: false, mintPrice, maxPerWallet, confidence: 'verified', reason: 'paused() = true' };
    }
    if (isSoldOut) {
      return { phase: 'soldout', isPublic: false, isWhitelist: false, isPaused: false, isSoldOut: true, mintPrice, maxPerWallet, confidence: 'verified', reason: `totalSupply ${totalSupply} >= maxSupply ${maxSupply}` };
    }
    if (saleActive === true || publicActive === true || mintingEnabled === true) {
      return { phase: 'public', isPublic: true, isWhitelist: false, isPaused: false, isSoldOut: false, mintPrice, maxPerWallet, confidence: 'verified', reason: 'public sale flag active' };
    }
    if (presaleActive === true) {
      return { phase: 'whitelist', isPublic: false, isWhitelist: true, isPaused: false, isSoldOut: false, mintPrice, maxPerWallet, confidence: 'verified', reason: 'presaleActive() = true' };
    }
    if (saleActive === false || publicActive === false) {
      return { phase: 'unknown', isPublic: false, isWhitelist: false, isPaused: false, isSoldOut: false, mintPrice, maxPerWallet, confidence: 'verified', reason: 'sale flag = false' };
    }

    return { phase: 'unknown', isPublic: false, isWhitelist: false, isPaused: false, isSoldOut: false, mintPrice, maxPerWallet, confidence: 'unknown', reason: 'No phase flags readable' };
  });
}
