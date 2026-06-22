// packages/core/src/mint/gasOracle.ts
// Dynamic gas estimation with EIP-1559, competitive tip oracle, and escalation.

import { ethers } from 'ethers';
import { withFailover } from '../rpc/rpcManager.js';

export interface GasParams {
  // EIP-1559 (preferred)
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  // Legacy fallback
  gasPrice?: bigint;
  gasLimit?: bigint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fee data with multiplier
// ─────────────────────────────────────────────────────────────────────────────

export async function getGasParams(
  chainId: number,
  multiplier = 1.15,
  customGweiOverride?: number,
): Promise<GasParams> {
  if (customGweiOverride && customGweiOverride > 0) {
    return buildParamsFromGwei(customGweiOverride, chainId);
  }

  return withFailover(chainId, async (provider) => {
    const feeData = await provider.getFeeData();

    // EIP-1559 (preferred — accurate fee prediction)
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      const bump = (v: bigint) => BigInt(Math.ceil(Number(v) * multiplier));
      return {
        maxFeePerGas: bump(feeData.maxFeePerGas),
        maxPriorityFeePerGas: bump(feeData.maxPriorityFeePerGas),
      };
    }

    // Legacy fallback
    if (feeData.gasPrice) {
      return { gasPrice: BigInt(Math.ceil(Number(feeData.gasPrice) * multiplier)) };
    }

    // Ultimate fallback — 20 gwei
    return { gasPrice: BigInt(20e9) };
  });
}

export function buildParamsFromGwei(gweiOverride: number, chainId: number): GasParams {
  const wei = BigInt(Math.round(gweiOverride * 1e9));
  // Assume EIP-1559 for chains that support it; BSC / legacy chains use gasPrice
  const legacyChains = new Set([56, 97]); // BSC
  if (legacyChains.has(chainId)) {
    return { gasPrice: wei };
  }
  // EIP-1559: maxPriorityFee = 1 gwei tip, maxFee = override
  const tip = BigInt(1e9);
  return {
    maxFeePerGas: wei,
    maxPriorityFeePerGas: tip < wei ? tip : wei,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gas limit estimation with retry and fallbacks
// ─────────────────────────────────────────────────────────────────────────────

export async function estimateGasLimit(
  contract: ethers.Contract,
  fnName: string,
  args: unknown[],
  value: bigint,
  fallback = BigInt(200_000),
): Promise<bigint> {
  try {
    const est = await contract[fnName].estimateGas(...args, { value });
    // Add 20% buffer over the estimate
    return BigInt(Math.ceil(Number(est) * 1.2));
  } catch {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Escalate gas for retries
// ─────────────────────────────────────────────────────────────────────────────

export function escalateGasParams(params: GasParams, percentIncrease: number): GasParams {
  const factor = 1 + percentIncrease / 100;
  const bump = (v: bigint) => BigInt(Math.ceil(Number(v) * factor));

  if (params.maxFeePerGas && params.maxPriorityFeePerGas) {
    return {
      maxFeePerGas: bump(params.maxFeePerGas),
      maxPriorityFeePerGas: bump(params.maxPriorityFeePerGas),
    };
  }
  if (params.gasPrice) {
    return { gasPrice: bump(params.gasPrice) };
  }
  return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// Required ETH calculation for a mint transaction
// ─────────────────────────────────────────────────────────────────────────────

export function calcRequiredEth(
  mintPriceEth: number,
  quantity: number,
  gasLimit: bigint,
  gasParams: GasParams,
  bufferMultiplier = 1.1,
): bigint {
  const mintValue = ethers.parseEther(
    (mintPriceEth * quantity).toFixed(18).replace(/\.?0+$/, '') || '0',
  );

  const gasPrice = gasParams.maxFeePerGas ?? gasParams.gasPrice ?? BigInt(20e9);
  const gasCost = gasLimit * gasPrice;
  const gasCostBuffered = BigInt(Math.ceil(Number(gasCost) * bufferMultiplier));

  return mintValue + gasCostBuffered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Balance validation
// ─────────────────────────────────────────────────────────────────────────────

export async function validateBalance(
  address: string,
  chainId: number,
  requiredWei: bigint,
): Promise<{ ok: boolean; balance: bigint; required: bigint; shortfall?: bigint }> {
  return withFailover(chainId, async (provider) => {
    const balance = await provider.getBalance(address);
    if (balance >= requiredWei) {
      return { ok: true, balance, required: requiredWei };
    }
    return { ok: false, balance, required: requiredWei, shortfall: requiredWei - balance };
  });
}
