// packages/core/src/risk/riskEngine.ts
// Contract risk analysis: rug score 0–100, ownership checks,
// proxy upgrade risk, withdraw function analysis, blacklist detection.

import { ethers } from 'ethers';
import { withFailover } from '../rpc/rpcManager.js';
import { detectProxy } from '../contract/intelligence.js';
import type { RiskReport } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// ABI fragments for risk checks
// ─────────────────────────────────────────────────────────────────────────────

const RISK_ABI = [
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
  'function renounced() view returns (bool)',
  'function isBlacklisted(address) view returns (bool)',
  'function blacklist(address) external',
  'function withdraw() external',
  'function withdrawETH() external',
  'function withdrawAll() external',
  'function setMintPrice(uint256) external',
  'function setMaxSupply(uint256) external',
  'function pause() external',
  'function unpause() external',
  'function setBaseURI(string) external',
  'function setContractURI(string) external',
  'function tradingRestricted() view returns (bool)',
  'function transfersEnabled() view returns (bool)',
  'function mintPaused() view returns (bool)',
];

const ZERO = ethers.ZeroAddress;

// ─────────────────────────────────────────────────────────────────────────────
// Helper: check if a function exists on-chain via callStatic
// ─────────────────────────────────────────────────────────────────────────────

async function abiHasFn(
  contract: ethers.Contract,
  fnName: string,
): Promise<boolean> {
  try {
    // Access the method — if it exists on the interface it won't throw
    return typeof contract[fnName] === 'function';
  } catch {
    return false;
  }
}

async function callSafe<T>(
  fn: () => Promise<T>,
): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership analysis
// ─────────────────────────────────────────────────────────────────────────────

async function analyzeOwnership(
  contract: ethers.Contract,
  contractAddress: string,
  chainId: number,
): Promise<{ ownerAddress: string | null; isRenounced: boolean; riskPoints: number; findings: string[] }> {
  const findings: string[] = [];
  let riskPoints = 0;

  const owner = await callSafe(() => contract.owner()) ??
                await callSafe(() => contract.getOwner());

  if (!owner) {
    findings.push('Owner function not found — cannot verify ownership');
    return { ownerAddress: null, isRenounced: false, riskPoints: 5, findings };
  }

  const ownerAddr = owner as string;

  if (ownerAddr === ZERO) {
    findings.push('✅ Ownership renounced (owner = 0x0)');
    return { ownerAddress: ownerAddr, isRenounced: true, riskPoints: -10, findings }; // negative = good
  }

  // Check if owner is an EOA or a contract (multisig = safer)
  return await withFailover(chainId, async (provider) => {
    const code = await provider.getCode(ownerAddr);
    const isContract = code !== '0x';

    if (isContract) {
      // Check if it looks like a Gnosis Safe (has threshold / getThreshold fn)
      try {
        const safeAbi = ['function getThreshold() view returns (uint256)'];
        const safe = new ethers.Contract(ownerAddr, safeAbi, provider);
        const threshold = await safe.getThreshold();
        findings.push(`✅ Owner is a multisig/Safe (threshold=${threshold})`);
      } catch {
        findings.push(`ℹ️ Owner is a contract (${ownerAddr.slice(0, 10)})`);
        riskPoints += 10; // unknown owner contract
      }
    } else {
      findings.push(`⚠️ Owner is an EOA (${ownerAddr.slice(0, 10)})`);
      riskPoints += 20; // single EOA owner = higher risk
    }

    return { ownerAddress: ownerAddr, isRenounced: false, riskPoints, findings };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Function-level risk signals
// ─────────────────────────────────────────────────────────────────────────────

function analyzeFunctions(
  abiJson: ethers.JsonFragment[] | null,
): { findings: string[]; riskPoints: number; flags: Record<string, boolean> } {
  const findings: string[] = [];
  let riskPoints = 0;
  const flags = {
    hasWithdraw: false,
    hasBlacklist: false,
    hasPause: false,
    hasMintPriceSetter: false,
    hasMaxSupplySetter: false,
    hasMetadataMutability: false,
  };

  if (!abiJson || !Array.isArray(abiJson)) {
    findings.push('⚠️ No verified ABI — cannot perform function-level analysis');
    riskPoints += 5;
    return { findings, riskPoints, flags };
  }

  const fnNames = abiJson
    .filter(f => f.type === 'function')
    .map(f => (f.name ?? '').toLowerCase());

  // Withdraw functions — owner can drain ETH
  if (fnNames.some(n => n.includes('withdraw'))) {
    flags.hasWithdraw = true;
    findings.push('⚠️ Withdraw function present — owner can withdraw ETH');
    riskPoints += 15;
  }

  // Blacklist — owner can block wallets from trading
  if (fnNames.some(n => n.includes('blacklist') || n === 'block' || n === 'ban')) {
    flags.hasBlacklist = true;
    findings.push('⚠️ Blacklist function present — owner can block wallets');
    riskPoints += 20;
  }

  // Pause — owner can halt all transfers
  if (fnNames.some(n => n === 'pause' || n === 'freezetrading')) {
    flags.hasPause = true;
    findings.push('ℹ️ Pause function present');
    riskPoints += 5;
  }

  // Mutable mint price — owner can raise price after launch
  if (fnNames.some(n => n.includes('setmintprice') || n.includes('setprice') || n === 'setcost')) {
    flags.hasMintPriceSetter = true;
    findings.push('⚠️ Mutable mint price — owner can change price');
    riskPoints += 10;
  }

  // Mutable max supply — owner can increase supply (dilution) or decrease (manipulation)
  if (fnNames.some(n => n.includes('setmaxsupply') || n.includes('settotalsupply'))) {
    flags.hasMaxSupplySetter = true;
    findings.push('⚠️ Mutable max supply — owner can change total supply');
    riskPoints += 15;
  }

  // Mutable metadata — owner can change token images/traits after reveal
  if (fnNames.some(n => n.includes('setbaseuri') || n.includes('setmetadata') || n.includes('setcontracturi'))) {
    flags.hasMetadataMutability = true;
    findings.push('⚠️ Mutable metadata — owner can change token URI');
    riskPoints += 10;
  }

  if (riskPoints === 0) {
    findings.push('✅ No high-risk function patterns detected');
  }

  return { findings, riskPoints, flags };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry: full risk report
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeContractRisk(
  contractAddress: string,
  chainId: number,
  abiJson: ethers.JsonFragment[] | null = null,
): Promise<RiskReport> {
  const findings: string[] = [];
  let totalRisk = 0;

  // 1. Proxy detection
  let isProxy = false;
  try {
    const proxy = await detectProxy(contractAddress, chainId);
    isProxy = proxy.isProxy;
    if (proxy.isProxy) {
      findings.push(`⚠️ Proxy contract detected (${proxy.proxyType}) — logic can be upgraded by owner`);
      totalRisk += 20;
    } else {
      findings.push('✅ Not a proxy — immutable logic');
    }
  } catch {
    findings.push('Could not check proxy status');
  }

  // 2. Ownership analysis
  const ownershipResult = await withFailover(chainId, async (provider) => {
    const contract = new ethers.Contract(contractAddress, RISK_ABI, provider);
    return analyzeOwnership(contract, contractAddress, chainId);
  }).catch(() => ({
    ownerAddress: null as string | null,
    isRenounced: false,
    riskPoints: 10,
    findings: ['Could not determine owner'],
  }));

  findings.push(...ownershipResult.findings);
  totalRisk += ownershipResult.riskPoints;

  // 3. Function-level analysis
  const fnAnalysis = analyzeFunctions(abiJson);
  findings.push(...fnAnalysis.findings);
  totalRisk += fnAnalysis.riskPoints;

  // 4. Supply manipulation check
  const supplyManipulation = fnAnalysis.flags.hasMaxSupplySetter;
  const metadataMutable = fnAnalysis.flags.hasMetadataMutability;

  // 5. Final score (clamp 0–100)
  const rugScore = Math.max(0, Math.min(100, totalRisk));

  let recommendation: RiskReport['recommendation'];
  if (rugScore <= 20) recommendation = 'SAFE';
  else if (rugScore <= 40) recommendation = 'CAUTION';
  else if (rugScore <= 65) recommendation = 'HIGH_RISK';
  else recommendation = 'CRITICAL';

  return {
    contractAddress,
    chainId,
    rugScore,
    ownershipRenounced: ownershipResult.isRenounced,
    isProxy,
    hasWithdrawFunction: fnAnalysis.flags.hasWithdraw,
    hasBlacklist: fnAnalysis.flags.hasBlacklist,
    hasPausableTrading: fnAnalysis.flags.hasPause,
    mintPauseDetected: fnAnalysis.flags.hasPause,
    supplyManipulation,
    metadataMutable,
    findings,
    recommendation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Price guard — detect price mismatches before minting
// ─────────────────────────────────────────────────────────────────────────────

const PRICE_ABI = [
  'function mintPrice() view returns (uint256)',
  'function price() view returns (uint256)',
  'function cost() view returns (uint256)',
  'function MINT_PRICE() view returns (uint256)',
  'function publicSalePrice() view returns (uint256)',
  'function allowlistPrice() view returns (uint256)',
];

interface PriceGuardResult {
  safe: boolean | null;      // null = cannot determine
  onChainPrice?: number;
  declaredPrice: number;
  confidence: 'verified' | 'inferred' | 'unknown';
  reason: string;
}

export async function checkMintPrice(
  contractAddress: string,
  chainId: number,
  declaredPriceEth: number,
): Promise<PriceGuardResult> {
  return withFailover(chainId, async (provider) => {
    const c = new ethers.Contract(contractAddress, PRICE_ABI, provider);

    for (const fn of ['mintPrice', 'price', 'cost', 'MINT_PRICE', 'publicSalePrice', 'allowlistPrice']) {
      try {
        const raw = await c[fn]();
        const onChainPrice = parseFloat(ethers.formatEther(raw));
        const diff = Math.abs(onChainPrice - declaredPriceEth);
        const pctDiff = declaredPriceEth > 0 ? diff / declaredPriceEth : diff;

        if (pctDiff < 0.001) {
          return { safe: true, onChainPrice, declaredPrice: declaredPriceEth, confidence: 'verified', reason: `${fn}() matches declared price (${onChainPrice} ETH)` };
        }

        return {
          safe: false,
          onChainPrice,
          declaredPrice: declaredPriceEth,
          confidence: 'verified',
          reason: `Price mismatch! On-chain: ${onChainPrice} ETH, declared: ${declaredPriceEth} ETH — ABORTING to prevent loss`,
        };
      } catch { /* try next */ }
    }

    return { safe: null, declaredPrice: declaredPriceEth, confidence: 'unknown', reason: 'No readable price function — cannot verify price on-chain' };
  });
}
