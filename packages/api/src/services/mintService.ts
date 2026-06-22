// packages/api/src/services/mintService.ts
// Orchestrates a mint run: antibot check → phase → risk → balance → execute.
// The antibot check is ALWAYS first — if a project chose to block bots, we stop
// immediately and tell the user to mint manually. We never circumvent this.

import { prisma } from '../plugins/db.js';
import { getDecryptedWallets } from './walletService.js';
import { detectAntibot } from '@apex/core/contract/antibotDetector';
import { detectPhase } from '@apex/core/contract/intelligence';
import { analyzeContractRisk, checkMintPrice } from '@apex/core/risk/riskEngine';
import { fetchABI } from '@apex/core/contract/intelligence';
import { mintFromWallet, mintWithRetry, SoldOutSignal } from '@apex/core/mint/evmMintEngine';
import { mintOnSolana } from '@apex/core/mint/solanaMintEngine';
import { getChain } from '@apex/core/chains/registry';
import { wipeString } from '@apex/core/wallet/vault';
import type { MintConfig, MintResult } from '@apex/core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight report (returned before executing — user can review and confirm)
// ─────────────────────────────────────────────────────────────────────────────

export interface PreflightReport {
  contractAddress: string;
  chainId: number;
  standard: string;
  phase: { phase: string; isPublic: boolean; mintPrice?: number; maxPerWallet?: number };
  antibot: { detected: boolean; severity: string; canAutomate: boolean; notifications: string[] };
  risk: { rugScore: number; recommendation: string; findings: string[] };
  priceGuard: { safe: boolean | null; onChainPrice?: number; reason: string };
  wallets: { address: string; eligible: boolean; reason?: string }[];
  readyToMint: boolean;
  blockers: string[];   // must all be empty for readyToMint to be true
  warnings: string[];   // non-fatal but shown to user
}

export async function preflight(
  userId: string,
  config: MintConfig,
  walletIds: string[],
): Promise<PreflightReport> {
  const { contractAddress, chainId = 1, mintPrice, quantity } = config;
  const blockers: string[] = [];
  const warnings: string[] = [];

  // 1. Fetch ABI once
  const abiJson = await fetchABI(contractAddress, chainId).catch(() => null);

  // 2. Antibot detection — FIRST ALWAYS
  const antibotResult = await detectAntibot(contractAddress, chainId, abiJson);
  if (!antibotResult.canAutomate) {
    blockers.push(...antibotResult.notifications);
  }

  // 3. Phase detection
  const phaseInfo = await detectPhase(contractAddress, chainId).catch(() => ({
    phase: 'unknown' as const, isPublic: false, isWhitelist: false,
    isPaused: false, isSoldOut: false, confidence: 'unknown' as const, reason: 'Phase check failed',
  }));

  if (phaseInfo.isPaused) blockers.push('Contract is paused ⏸');
  if (phaseInfo.isSoldOut) blockers.push('Collection is sold out ⛔');
  if (phaseInfo.phase === 'unknown' && antibotResult.severity === 'NONE') {
    warnings.push('Could not verify mint phase — proceed with caution');
  }

  // 4. Risk analysis
  const riskReport = await analyzeContractRisk(contractAddress, chainId, abiJson as never).catch(() => null);
  if (riskReport?.recommendation === 'CRITICAL') {
    blockers.push(`High rug risk (score: ${riskReport.rugScore}/100) — minting blocked`);
  } else if (riskReport?.recommendation === 'HIGH_RISK') {
    warnings.push(`Elevated rug risk (score: ${riskReport.rugScore}/100) — proceed carefully`);
  }

  // 5. Price guard
  const priceGuard = await checkMintPrice(contractAddress, chainId, mintPrice).catch(() => ({
    safe: null as null, declaredPrice: mintPrice, confidence: 'unknown' as const, reason: 'Price check unavailable',
  }));
  if (priceGuard.safe === false) {
    blockers.push(priceGuard.reason);
  }

  // 6. Wallet eligibility
  const wallets = await getDecryptedWallets(userId, walletIds);
  const walletChecks = wallets.map(w => {
    // Spend limit check
    if (w.spendLimitEth !== undefined && mintPrice * quantity > w.spendLimitEth) {
      return {
        address: w.address,
        eligible: false,
        reason: `Mint cost ${(mintPrice * quantity).toFixed(4)} ETH exceeds spend limit ${w.spendLimitEth} ETH`,
      };
    }
    return { address: w.address, eligible: true };
  });

  // Wipe decrypted keys immediately — we don't need them in preflight
  wallets.forEach(w => wipeString(w.privateKey));

  // 7. Detect standard
  const { detectTokenStandard } = await import('@apex/core/contract/intelligence');
  const standard = await detectTokenStandard(contractAddress, chainId).catch(() => 'UNKNOWN');

  const readyToMint = blockers.length === 0 && walletChecks.some(w => w.eligible);

  return {
    contractAddress,
    chainId,
    standard,
    phase: {
      phase: phaseInfo.phase,
      isPublic: phaseInfo.isPublic,
      mintPrice: phaseInfo.mintPrice,
      maxPerWallet: phaseInfo.maxPerWallet,
    },
    antibot: {
      detected: antibotResult.detected,
      severity: antibotResult.severity,
      canAutomate: antibotResult.canAutomate,
      notifications: antibotResult.notifications,
    },
    risk: {
      rugScore: riskReport?.rugScore ?? 0,
      recommendation: riskReport?.recommendation ?? 'UNKNOWN',
      findings: riskReport?.findings ?? [],
    },
    priceGuard: {
      safe: priceGuard.safe,
      onChainPrice: (priceGuard as { onChainPrice?: number }).onChainPrice,
      reason: priceGuard.reason,
    },
    wallets: walletChecks,
    readyToMint,
    blockers,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute mint
// ─────────────────────────────────────────────────────────────────────────────

export interface MintRunResult {
  scheduleId?: string;
  results: MintResult[];
  summary: { total: number; success: number; failed: number; skipped: number };
  antibotNotification?: string; // shown when antibot blocks
}

export async function executeMint(
  userId: string,
  config: MintConfig,
  walletIds: string[],
  scheduleId?: string,
): Promise<MintRunResult> {
  const { contractAddress, chainId = 1 } = config;

  // ── STEP 1: Antibot detection — blocks if project chose to restrict bots ──
  const abiJson = await fetchABI(contractAddress, chainId).catch(() => null);
  const antibotResult = await detectAntibot(contractAddress, chainId, abiJson);

  if (!antibotResult.canAutomate) {
    // Record the attempt
    await prisma.mintRecord.create({
      data: {
        userId,
        scheduleId: scheduleId ?? null,
        walletAddress: 'N/A',
        contractAddress,
        chainId,
        status: 'skipped',
        mintPrice: config.mintPrice,
        quantity: config.quantity,
        errorMsg: 'ANTIBOT_BLOCKED',
      },
    });

    return {
      scheduleId,
      results: [],
      summary: { total: 0, success: 0, failed: 0, skipped: 0 },
      antibotNotification: antibotResult.notifications.join('\n\n'),
    };
  }

  // ── STEP 2: Phase check ───────────────────────────────────────────────────
  const phase = await detectPhase(contractAddress, chainId).catch(() => null);
  if (phase?.isPaused) {
    return buildSkippedResult(userId, config, walletIds, 'Contract paused', scheduleId);
  }
  if (phase?.isSoldOut) {
    return buildSkippedResult(userId, config, walletIds, 'Sold out', scheduleId);
  }

  // ── STEP 3: Load wallets ──────────────────────────────────────────────────
  const wallets = await getDecryptedWallets(userId, walletIds);
  if (wallets.length === 0) {
    throw Object.assign(new Error('No active wallets found for this mint'), { statusCode: 400 });
  }

  const chain = getChain(chainId);
  const isSolana = !chain.isEVM;

  // ── STEP 4: Execute (EVM or Solana) ──────────────────────────────────────
  let results: MintResult[];

  if (isSolana) {
    results = await Promise.all(
      wallets.map(w =>
        mintOnSolana({
          wallet: w,
          candyMachineId: contractAddress,
          cmVersion: (config as { cmVersion?: 'v2' | 'v3' }).cmVersion ?? 'v3',
          mintPriceSol: config.mintPrice,
          quantity: config.quantity,
          useJito: false, // Jito available but off by default
        }).catch(err => ({
          walletAddress: w.address,
          status: 'failed' as const,
          error: (err as Error).message,
        })),
      ),
    );
  } else {
    // EVM — sequential per wallet (respects per-wallet limits naturally)
    const soldOutSignal = new SoldOutSignal();
    results = await Promise.all(
      wallets.map(w =>
        mintWithRetry({
          wallet: w,
          config,
          soldOutSignal,
          timeoutMs: 90_000,
          gasEscalatePercent: config.gasEscalatePercent ?? 10,
          onAttempt: info => {
            console.info(`[Mint] ${w.address.slice(0, 8)} attempt=${info.attempt} status=${info.status}`);
          },
        }).catch(err => ({
          walletAddress: w.address,
          status: 'failed' as const,
          error: (err as Error).message,
        })),
      ),
    );
  }

  // ── STEP 5: Wipe keys ─────────────────────────────────────────────────────
  wallets.forEach(w => wipeString(w.privateKey));

  // ── STEP 6: Persist results ───────────────────────────────────────────────
  await prisma.mintRecord.createMany({
    data: results.map(r => ({
      userId,
      scheduleId: scheduleId ?? null,
      walletAddress: r.walletAddress,
      contractAddress,
      chainId,
      txHash: r.txHash ?? null,
      status: r.status,
      fnName: r.fnName ?? null,
      gasUsed: r.gasUsed ?? null,
      gasCostEth: r.gasCostEth ?? null,
      mintPrice: config.mintPrice,
      quantity: config.quantity,
      errorMsg: r.error ?? null,
      blockNumber: r.blockNumber ? BigInt(r.blockNumber) : null,
      rugScore: r.rugScore ?? null,
    })),
  });

  const success = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => ['skipped', 'price_warning', 'dry-run-ok', 'dry-run-fail'].includes(r.status)).length;

  return {
    scheduleId,
    results,
    summary: { total: results.length, success, failed, skipped },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function buildSkippedResult(
  userId: string,
  config: MintConfig,
  walletIds: string[],
  reason: string,
  scheduleId?: string,
): Promise<MintRunResult> {
  const wallets = await getDecryptedWallets(userId, walletIds);
  const results: MintResult[] = wallets.map(w => ({
    walletAddress: w.address,
    status: 'skipped',
    error: reason,
  }));
  wallets.forEach(w => wipeString(w.privateKey));

  return { scheduleId, results, summary: { total: results.length, success: 0, failed: 0, skipped: results.length } };
}
