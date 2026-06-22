// packages/core/src/types/index.ts

export type ChainId = number;
export type Hex = `0x${string}`;
export type SolanaAddress = string;

export enum Tier {
  BASIC = 'BASIC',
  PREMIUM = 'PREMIUM',
  ENTERPRISE = 'ENTERPRISE',
}

export const TIER_FEATURES: Record<Tier, string[]> = {
  [Tier.BASIC]: ['evm-mint', 'single-wallet'],
  [Tier.PREMIUM]: ['evm-mint', 'solana-mint', 'multi-wallet', 'scheduling', 'portfolio', 'flashbots', 'jito', 'auto-list', 'auto-sell', 'risk-engine'],
  [Tier.ENTERPRISE]: ['*'], // all features
};

export const WALLET_LIMITS: Record<Tier, number> = {
  [Tier.BASIC]: 3,
  [Tier.PREMIUM]: 50,
  [Tier.ENTERPRISE]: 500,
};

export const SCHEDULE_LIMITS: Record<Tier, number> = {
  [Tier.BASIC]: 1,
  [Tier.PREMIUM]: 20,
  [Tier.ENTERPRISE]: 200,
};

// ── Chain types ───────────────────────────────────────────────────────────────

export interface ChainConfig {
  id: number;
  name: string;
  shortName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrl: string;
  explorerApiUrl?: string;
  explorerApiKey?: string;
  isEVM: boolean;
  supportedFeatures: string[];
  avgBlockTime: number; // ms
}

// ── Wallet types ──────────────────────────────────────────────────────────────

export interface WalletVaultEntry {
  id: string;
  userId: string;
  chain: 'evm' | 'solana';
  address: string;
  label?: string;
  chainIds: number[];
  spendLimitEth?: number;
  isActive: boolean;
  isBurner: boolean;
}

export interface DecryptedWallet extends WalletVaultEntry {
  privateKey: string;
}

// ── Mint types ────────────────────────────────────────────────────────────────

export interface MintConfig {
  contractAddress: string;
  chainId: number;
  quantity: number;
  mintPrice: number; // in native currency (ETH, SOL, etc.)
  customFn?: string;
  gweiOverride?: number;
  merkleProof?: string[];
  proofMap?: Record<string, string[]>;
  eip712Sig?: string;
  eip712Sigs?: Record<string, string>;
  merkleApiUrl?: string;
  tokenId?: number;
  standard?: 'auto' | 'ERC721' | 'ERC1155';
  useFlashbots?: boolean;
  proofMode?: 'none' | 'auto' | 'seadrop' | 'flashbots';
  dryRun?: boolean;
  skipMaxCheck?: boolean;
  gasEscalatePercent?: number;
  useLaunchpadProof?: boolean;
  walletAddresses?: string[]; // restrict to specific wallets
  spendLimits?: Record<string, number>;
}

export interface MintResult {
  walletAddress: string;
  status: 'success' | 'failed' | 'pending' | 'skipped' | 'dry-run-ok' | 'dry-run-fail' | 'price_warning' | 'timeout' | 'dropped' | 'replaced';
  txHash?: string;
  gasUsed?: string;
  gasCostEth?: number;
  blockNumber?: number;
  fnName?: string;
  error?: string;
  attempts?: number;
  priceGuard?: { confidence: string; reason: string };
  rugScore?: number;
  standard?: string;
}

// ── Schedule types ────────────────────────────────────────────────────────────

export interface ScheduleConfig extends MintConfig {
  scheduleId: string;
  userId: string;
  mintTime?: string; // ISO string
  waitForPhase?: boolean;
  phaseCheckIntervalMs?: number;
  phaseMaxWaitMs?: number;
  timeoutMs?: number;
}

// ── Risk types ────────────────────────────────────────────────────────────────

export interface RiskReport {
  contractAddress: string;
  chainId: number;
  rugScore: number; // 0–100 (higher = riskier)
  ownershipRenounced: boolean;
  isProxy: boolean;
  hasWithdrawFunction: boolean;
  hasBlacklist: boolean;
  hasPausableTrading: boolean;
  mintPauseDetected: boolean;
  supplyManipulation: boolean;
  metadataMutable: boolean;
  findings: string[];
  recommendation: 'SAFE' | 'CAUTION' | 'HIGH_RISK' | 'CRITICAL';
}

// ── RPC types ─────────────────────────────────────────────────────────────────

export interface RpcEndpoint {
  url: string;
  chainId: number;
  latencyMs: number;
  blockNumber: number;
  score: number; // 0–100
  isActive: boolean;
  errorRate: number;
  lastChecked: number;
}

// ── Job queue types ───────────────────────────────────────────────────────────

export interface MintJobData {
  type: 'immediate' | 'scheduled';
  userId: string;
  scheduleId?: string;
  mintConfig: MintConfig;
  walletIds: string[]; // db wallet IDs (not decrypted keys)
}

export interface PortfolioSyncJobData {
  userId: string;
  walletAddresses: string[];
  chainIds: number[];
}
