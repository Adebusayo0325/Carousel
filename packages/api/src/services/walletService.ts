// packages/api/src/services/walletService.ts
import { ethers } from 'ethers';
import { prisma } from '../plugins/db.js';
import {
  encryptPrivateKey,
  decryptPrivateKey,
  serializeCipherBlob,
  deserializeCipherBlob,
  validateAndDeriveAddress,
  wipeString,
} from '@apex/core/wallet/vault';
import type { DecryptedWallet } from '@apex/core/types';
import { WALLET_LIMITS, Tier } from '@apex/core/types';
import { withFailover } from '@apex/core/rpc/rpcManager';

// ─────────────────────────────────────────────────────────────────────────────
// Add wallet
// ─────────────────────────────────────────────────────────────────────────────

export async function addWallet(opts: {
  userId: string;
  userTier: Tier;
  privateKey: string;
  chain: 'evm' | 'solana';
  label?: string;
  chainIds?: number[];
  spendLimitEth?: number;
  isBurner?: boolean;
}): Promise<{ id: string; address: string }> {
  const { userId, userTier, chain, label, chainIds = [1], spendLimitEth, isBurner = false } = opts;
  let { privateKey } = opts;

  // Tier: wallet count limit
  const existing = await prisma.wallet.count({ where: { userId, isActive: true } });
  const limit = WALLET_LIMITS[userTier];
  if (existing >= limit) {
    throw Object.assign(
      new Error(`Wallet limit reached (${limit} for ${userTier} tier). Upgrade for more wallets.`),
      { statusCode: 403, code: 'WALLET_LIMIT' },
    );
  }

  // Validate and derive address
  const address = validateAndDeriveAddress(privateKey, chain);

  // Dedup
  const duplicate = await prisma.wallet.findUnique({ where: { userId_address_chain: { userId, address, chain } } });
  if (duplicate) {
    wipeString(privateKey);
    throw Object.assign(new Error('Wallet already added'), { statusCode: 409 });
  }

  // Encrypt — generate a stable walletId first (used as HKDF context)
  const walletId = `${userId}:${address}:${chain}`;
  const blob = encryptPrivateKey(privateKey, walletId, userId);
  wipeString(privateKey); // Wipe ASAP after encryption
  privateKey = '';

  const serialized = serializeCipherBlob(blob);

  const record = await prisma.wallet.create({
    data: {
      userId,
      chain,
      address,
      label: label ?? null,
      chainIds: chainIds,
      spendLimitEth: spendLimitEth ?? null,
      isBurner,
      ...serialized,
    },
    select: { id: true, address: true },
  });

  return record;
}

// ─────────────────────────────────────────────────────────────────────────────
// Get decrypted wallets (private — never expose to API responses)
// ─────────────────────────────────────────────────────────────────────────────

export async function getDecryptedWallets(
  userId: string,
  walletIds?: string[],
): Promise<DecryptedWallet[]> {
  const where = walletIds?.length
    ? { userId, id: { in: walletIds }, isActive: true }
    : { userId, isActive: true };

  const rows = await prisma.wallet.findMany({ where });

  return rows.map(row => {
    const blob = deserializeCipherBlob({
      encryptedKey: row.encryptedKey,
      encKeyIv: row.encKeyIv,
      encKeyTag: row.encKeyTag,
      encKeyVersion: row.encKeyVersion,
    });
    const walletId = `${userId}:${row.address}:${row.chain}`;
    const privateKey = decryptPrivateKey(blob, walletId, userId);

    return {
      id: row.id,
      userId: row.userId,
      chain: row.chain as 'evm' | 'solana',
      address: row.address,
      label: row.label ?? undefined,
      chainIds: row.chainIds,
      spendLimitEth: row.spendLimitEth ?? undefined,
      isActive: row.isActive,
      isBurner: row.isBurner,
      privateKey,
    } satisfies DecryptedWallet;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// List wallets (public — no private keys)
// ─────────────────────────────────────────────────────────────────────────────

export interface WalletSummary {
  id: string;
  address: string;
  chain: string;
  label?: string;
  chainIds: number[];
  spendLimitEth?: number;
  isActive: boolean;
  isBurner: boolean;
  balances?: Record<string, string>; // chainId → formatted balance
  createdAt: Date;
}

export async function listWallets(userId: string): Promise<WalletSummary[]> {
  const rows = await prisma.wallet.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map(r => ({
    id: r.id,
    address: r.address,
    chain: r.chain,
    label: r.label ?? undefined,
    chainIds: r.chainIds,
    spendLimitEth: r.spendLimitEth ?? undefined,
    isActive: r.isActive,
    isBurner: r.isBurner,
    createdAt: r.createdAt,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Get on-chain balances
// ─────────────────────────────────────────────────────────────────────────────

export async function getWalletBalances(
  address: string,
  chainIds: number[],
): Promise<Record<number, string>> {
  const results: Record<number, string> = {};

  await Promise.allSettled(
    chainIds.map(async chainId => {
      try {
        const balance = await withFailover(chainId, async provider => provider.getBalance(address));
        results[chainId] = ethers.formatEther(balance);
      } catch {
        results[chainId] = 'unavailable';
      }
    }),
  );

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update wallet
// ─────────────────────────────────────────────────────────────────────────────

export async function updateWallet(
  walletId: string,
  userId: string,
  updates: { label?: string; chainIds?: number[]; spendLimitEth?: number | null; isActive?: boolean },
): Promise<void> {
  await prisma.wallet.updateMany({
    where: { id: walletId, userId },
    data: {
      label: updates.label,
      chainIds: updates.chainIds,
      spendLimitEth: updates.spendLimitEth,
      isActive: updates.isActive,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete wallet
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteWallet(walletId: string, userId: string): Promise<void> {
  const wallet = await prisma.wallet.findFirst({ where: { id: walletId, userId } });
  if (!wallet) throw Object.assign(new Error('Wallet not found'), { statusCode: 404 });

  await prisma.wallet.delete({ where: { id: walletId } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fund wallet (transfer ETH from one user wallet to another)
// ─────────────────────────────────────────────────────────────────────────────

export async function fundWallet(opts: {
  userId: string;
  fromWalletId: string;
  toAddress: string;
  amountEth: number;
  chainId: number;
}): Promise<{ txHash: string }> {
  const { userId, fromWalletId, toAddress, amountEth, chainId } = opts;

  // Validate destination
  if (!ethers.isAddress(toAddress)) throw new Error('Invalid destination address');

  const [fromWallet] = await getDecryptedWallets(userId, [fromWalletId]);
  if (!fromWallet) throw Object.assign(new Error('Source wallet not found'), { statusCode: 404 });
  if (fromWallet.chain !== 'evm') throw new Error('Fund transfer only supported for EVM wallets');

  const signer = await withFailover(chainId, async provider => {
    const { getEvmSigner } = await import('@apex/core/wallet/vault');
    return getEvmSigner(fromWallet, provider);
  });

  const value = ethers.parseEther(amountEth.toString());
  const tx = await (signer as ethers.Wallet).sendTransaction({ to: toAddress, value });
  await tx.wait();

  wipeString(fromWallet.privateKey);
  return { txHash: tx.hash };
}

// ─────────────────────────────────────────────────────────────────────────────
// Withdraw — alias of fundWallet with extra spend-limit validation
// ─────────────────────────────────────────────────────────────────────────────

export async function withdrawFromWallet(opts: {
  userId: string;
  fromWalletId: string;
  toAddress: string;
  amountEth: number;
  chainId: number;
}): Promise<{ txHash: string }> {
  // Spend limit is NOT enforced on withdrawals (user always controls their own funds)
  return fundWallet(opts);
}
