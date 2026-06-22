// packages/core/src/chains/registry.ts
// Plugin-based chain architecture — add new chains without touching core code.
// Each chain exports a ChainAdapter that implements the standard interface.

import type { ChainConfig } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// CHAIN REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

export const CHAIN_REGISTRY: Record<number, ChainConfig> = {
  // ── Ethereum Mainnet
  1: {
    id: 1, name: 'Ethereum', shortName: 'eth',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: parseRpcList(process.env.RPC_1) ?? ['https://eth.llamarpc.com'],
    blockExplorerUrl: 'https://etherscan.io',
    explorerApiUrl: 'https://api.etherscan.io/api',
    explorerApiKey: process.env.ETHERSCAN_API_KEY,
    isEVM: true, avgBlockTime: 12000,
    supportedFeatures: ['flashbots', 'eip1559', 'tenderly'],
  },
  // ── Base
  8453: {
    id: 8453, name: 'Base', shortName: 'base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: parseRpcList(process.env.RPC_8453) ?? ['https://mainnet.base.org'],
    blockExplorerUrl: 'https://basescan.org',
    explorerApiUrl: 'https://api.basescan.org/api',
    explorerApiKey: process.env.BASESCAN_API_KEY,
    isEVM: true, avgBlockTime: 2000,
    supportedFeatures: ['eip1559'],
  },
  // ── Arbitrum One
  42161: {
    id: 42161, name: 'Arbitrum One', shortName: 'arb',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: parseRpcList(process.env.RPC_42161) ?? ['https://arb1.arbitrum.io/rpc'],
    blockExplorerUrl: 'https://arbiscan.io',
    explorerApiUrl: 'https://api.arbiscan.io/api',
    explorerApiKey: process.env.ARBISCAN_API_KEY,
    isEVM: true, avgBlockTime: 250,
    supportedFeatures: ['eip1559'],
  },
  // ── Optimism
  10: {
    id: 10, name: 'Optimism', shortName: 'op',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: parseRpcList(process.env.RPC_10) ?? ['https://mainnet.optimism.io'],
    blockExplorerUrl: 'https://optimistic.etherscan.io',
    explorerApiUrl: 'https://api-optimistic.etherscan.io/api',
    explorerApiKey: process.env.OPTIMISM_ETHERSCAN_API_KEY,
    isEVM: true, avgBlockTime: 2000,
    supportedFeatures: ['eip1559'],
  },
  // ── Polygon
  137: {
    id: 137, name: 'Polygon', shortName: 'matic',
    nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
    rpcUrls: parseRpcList(process.env.RPC_137) ?? ['https://polygon-rpc.com'],
    blockExplorerUrl: 'https://polygonscan.com',
    explorerApiUrl: 'https://api.polygonscan.com/api',
    explorerApiKey: process.env.POLYGONSCAN_API_KEY,
    isEVM: true, avgBlockTime: 2000,
    supportedFeatures: ['eip1559'],
  },
  // ── BNB Smart Chain
  56: {
    id: 56, name: 'BNB Smart Chain', shortName: 'bsc',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: parseRpcList(process.env.RPC_56) ?? ['https://bsc-dataseed.binance.org'],
    blockExplorerUrl: 'https://bscscan.com',
    explorerApiUrl: 'https://api.bscscan.com/api',
    explorerApiKey: process.env.BSCSCAN_API_KEY,
    isEVM: true, avgBlockTime: 3000,
    supportedFeatures: [],
  },
  // ── Blast
  81457: {
    id: 81457, name: 'Blast', shortName: 'blast',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: parseRpcList(process.env.RPC_81457) ?? ['https://rpc.blast.io'],
    blockExplorerUrl: 'https://blastscan.io',
    isEVM: true, avgBlockTime: 2000,
    supportedFeatures: ['eip1559'],
  },
  // ── Linea
  59144: {
    id: 59144, name: 'Linea', shortName: 'linea',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: parseRpcList(process.env.RPC_59144) ?? ['https://rpc.linea.build'],
    blockExplorerUrl: 'https://lineascan.build',
    isEVM: true, avgBlockTime: 2000,
    supportedFeatures: ['eip1559'],
  },
  // ── Zora
  7777777: {
    id: 7777777, name: 'Zora', shortName: 'zora',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: parseRpcList(process.env.RPC_7777777) ?? ['https://rpc.zora.energy'],
    blockExplorerUrl: 'https://explorer.zora.energy',
    isEVM: true, avgBlockTime: 2000,
    supportedFeatures: ['eip1559'],
  },
  // ── Avalanche C-Chain
  43114: {
    id: 43114, name: 'Avalanche', shortName: 'avax',
    nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
    rpcUrls: parseRpcList(process.env.RPC_43114) ?? ['https://api.avax.network/ext/bc/C/rpc'],
    blockExplorerUrl: 'https://snowtrace.io',
    isEVM: true, avgBlockTime: 2000,
    supportedFeatures: ['eip1559'],
  },
  // ── ApeChain
  33139: {
    id: 33139, name: 'ApeChain', shortName: 'ape',
    nativeCurrency: { name: 'APE', symbol: 'APE', decimals: 18 },
    rpcUrls: parseRpcList(process.env.RPC_33139) ?? ['https://rpc.apechain.com'],
    blockExplorerUrl: 'https://apescan.io',
    isEVM: true, avgBlockTime: 2000,
    supportedFeatures: ['eip1559'],
  },
};

// Solana — separate handling (not EVM)
export const SOLANA_CONFIG = {
  name: 'Solana',
  shortName: 'sol',
  rpcUrls: [
    process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
    process.env.SOLANA_RPC_URL_2 ?? 'https://solana-api.projectserum.com',
  ].filter(Boolean),
  blockExplorerUrl: 'https://solscan.io',
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseRpcList(env: string | undefined): string[] | undefined {
  if (!env) return undefined;
  return env.split(',').map(s => s.trim()).filter(Boolean);
}

export function getChain(chainId: number): ChainConfig {
  const chain = CHAIN_REGISTRY[chainId];
  if (!chain) throw new Error(`Unsupported chain: ${chainId}. Add it to packages/core/src/chains/registry.ts`);
  return chain;
}

export function getAllEVMChainIds(): number[] {
  return Object.keys(CHAIN_REGISTRY).map(Number);
}

export function getExplorerTxUrl(chainId: number, txHash: string): string {
  const chain = CHAIN_REGISTRY[chainId];
  if (!chain) return txHash;
  return `${chain.blockExplorerUrl}/tx/${txHash}`;
}

export function getExplorerAddressUrl(chainId: number, address: string): string {
  const chain = CHAIN_REGISTRY[chainId];
  if (!chain) return address;
  return `${chain.blockExplorerUrl}/address/${address}`;
}

/** Register a custom chain at runtime (Enterprise feature) */
export function registerChain(config: ChainConfig): void {
  CHAIN_REGISTRY[config.id] = config;
}
