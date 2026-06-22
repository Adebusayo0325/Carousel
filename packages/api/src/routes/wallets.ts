// packages/api/src/routes/wallets.ts
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/authenticate.js';
import { writeAuditLog } from '../middleware/tierGate.js';
import {
  addWallet, listWallets, updateWallet, deleteWallet,
  getWalletBalances, fundWallet, withdrawFromWallet,
} from '../services/walletService.js';
import { Tier } from '@apex/core/types';

export async function walletRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  // ── GET /wallets ────────────────────────────────────────────────────────
  app.get('/wallets', auth, async (req, reply) => {
    const wallets = await listWallets(req.userId);
    return reply.send({ wallets });
  });

  // ── GET /wallets/:id/balances ──────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { chainIds?: string } }>(
    '/wallets/:id/balances', auth,
    async (req, reply) => {
      const wallets = await listWallets(req.userId);
      const wallet = wallets.find(w => w.id === req.params.id);
      if (!wallet) return reply.code(404).send({ error: 'Wallet not found' });

      const chainIds = req.query.chainIds
        ? req.query.chainIds.split(',').map(Number)
        : wallet.chainIds;

      const balances = await getWalletBalances(wallet.address, chainIds);
      return reply.send({ address: wallet.address, balances });
    },
  );

  // ── POST /wallets ───────────────────────────────────────────────────────
  app.post<{
    Body: {
      privateKey: string;
      chain?: 'evm' | 'solana';
      label?: string;
      chainIds?: number[];
      spendLimitEth?: number;
      isBurner?: boolean;
    };
  }>(
    '/wallets', auth,
    async (req, reply) => {
      const { privateKey, chain = 'evm', label, chainIds, spendLimitEth, isBurner } = req.body;

      const result = await addWallet({
        userId: req.userId,
        userTier: req.userTier,
        privateKey,
        chain,
        label,
        chainIds,
        spendLimitEth,
        isBurner,
      });

      writeAuditLog({
        userId: req.userId,
        action: 'WALLET_ADD',
        resource: 'wallet',
        resourceId: result.id,
        ipAddress: req.ip,
        metadata: { address: result.address, chain, label },
      });

      return reply.code(201).send({ id: result.id, address: result.address });
    },
  );

  // ── PATCH /wallets/:id ──────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: { label?: string; chainIds?: number[]; spendLimitEth?: number | null; isActive?: boolean };
  }>(
    '/wallets/:id', auth,
    async (req, reply) => {
      await updateWallet(req.params.id, req.userId, req.body);
      writeAuditLog({ userId: req.userId, action: 'WALLET_UPDATE', resourceId: req.params.id });
      return reply.send({ success: true });
    },
  );

  // ── DELETE /wallets/:id ─────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/wallets/:id', auth,
    async (req, reply) => {
      await deleteWallet(req.params.id, req.userId);
      writeAuditLog({ userId: req.userId, action: 'WALLET_DELETE', resourceId: req.params.id, ipAddress: req.ip });
      return reply.send({ success: true });
    },
  );

  // ── POST /wallets/:id/fund ──────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { toAddress: string; amountEth: number; chainId: number };
  }>(
    '/wallets/:id/fund', auth,
    async (req, reply) => {
      const { toAddress, amountEth, chainId } = req.body;
      const result = await fundWallet({ userId: req.userId, fromWalletId: req.params.id, toAddress, amountEth, chainId });
      writeAuditLog({ userId: req.userId, action: 'WALLET_FUND', resourceId: req.params.id, metadata: { toAddress, amountEth, chainId } });
      return reply.send(result);
    },
  );

  // ── POST /wallets/:id/withdraw ──────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { toAddress: string; amountEth: number; chainId: number };
  }>(
    '/wallets/:id/withdraw', auth,
    async (req, reply) => {
      const { toAddress, amountEth, chainId } = req.body;
      const result = await withdrawFromWallet({ userId: req.userId, fromWalletId: req.params.id, toAddress, amountEth, chainId });
      writeAuditLog({ userId: req.userId, action: 'WALLET_WITHDRAW', resourceId: req.params.id, metadata: { toAddress, amountEth, chainId } });
      return reply.send(result);
    },
  );
}
