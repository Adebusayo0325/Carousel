// packages/api/src/routes/mint.ts
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/authenticate.js';
import { writeAuditLog } from '../middleware/tierGate.js';
import { preflight, executeMint } from '../services/mintService.js';
import { prisma } from '../plugins/db.js';
import { acquireLock, releaseLock } from '../plugins/redis.js';
import { detectAntibot } from '@apex/core/contract/antibotDetector';
import { detectPhase } from '@apex/core/contract/intelligence';
import { fetchABI } from '@apex/core/contract/intelligence';
import { analyzeContractRisk } from '@apex/core/risk/riskEngine';

export async function mintRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  // ── POST /mint/preflight ────────────────────────────────────────────────
  // Run all safety checks and return a full report BEFORE spending gas.
  app.post<{ Body: { contractAddress: string; chainId: number; mintPrice: number; quantity: number; walletIds: string[]; customFn?: string } }>(
    '/mint/preflight', auth,
    async (req, reply) => {
      const { contractAddress, chainId, mintPrice, quantity, walletIds, customFn } = req.body;

      const report = await preflight(req.userId, {
        contractAddress, chainId, mintPrice, quantity,
        customFn, dryRun: false,
      }, walletIds);

      writeAuditLog({ userId: req.userId, action: 'MINT_PREFLIGHT', metadata: { contractAddress, chainId } });
      return reply.send(report);
    },
  );

  // ── POST /mint/antibot-check ────────────────────────────────────────────
  // Quick antibot-only scan — useful before setting up a schedule.
  app.post<{ Body: { contractAddress: string; chainId: number } }>(
    '/mint/antibot-check', auth,
    async (req, reply) => {
      const { contractAddress, chainId } = req.body;
      const abiJson = await fetchABI(contractAddress, chainId).catch(() => null);
      const result = await detectAntibot(contractAddress, chainId, abiJson);
      return reply.send(result);
    },
  );

  // ── POST /mint/phase-check ──────────────────────────────────────────────
  app.post<{ Body: { contractAddress: string; chainId: number } }>(
    '/mint/phase-check', auth,
    async (req, reply) => {
      const { contractAddress, chainId } = req.body;
      const phase = await detectPhase(contractAddress, chainId);
      return reply.send(phase);
    },
  );

  // ── POST /mint/risk-check ───────────────────────────────────────────────
  app.post<{ Body: { contractAddress: string; chainId: number } }>(
    '/mint/risk-check', auth,
    async (req, reply) => {
      const { contractAddress, chainId } = req.body;
      const abiJson = await fetchABI(contractAddress, chainId).catch(() => null);
      const report = await analyzeContractRisk(contractAddress, chainId, abiJson as never);
      return reply.send(report);
    },
  );

  // ── POST /mint/execute ──────────────────────────────────────────────────
  // Execute a mint run now.
  app.post<{
    Body: {
      contractAddress: string;
      chainId: number;
      mintPrice: number;
      quantity: number;
      walletIds: string[];
      customFn?: string;
      gweiOverride?: number;
      merkleProof?: string[];
      merkleApiUrl?: string;
      eip712Sig?: string;
      tokenId?: number;
      standard?: 'auto' | 'ERC721' | 'ERC1155';
      dryRun?: boolean;
      skipMaxCheck?: boolean;
      gasEscalatePercent?: number;
      useFlashbots?: boolean;
    };
  }>(
    '/mint/execute', auth,
    async (req, reply) => {
      const { walletIds, ...mintConfig } = req.body;

      // Distributed lock — prevent double-submitting same contract from same user
      const lockKey = `mint:${req.userId}:${mintConfig.contractAddress}:${mintConfig.chainId}`;
      const lockId = await acquireLock(lockKey, 120_000);
      if (!lockId) {
        return reply.code(429).send({ error: 'A mint for this contract is already in progress. Wait for it to complete.' });
      }

      try {
        writeAuditLog({
          userId: req.userId,
          action: 'MINT_EXECUTE_START',
          metadata: { contractAddress: mintConfig.contractAddress, chainId: mintConfig.chainId, wallets: walletIds.length },
        });

        const result = await executeMint(req.userId, mintConfig, walletIds);

        writeAuditLog({
          userId: req.userId,
          action: 'MINT_EXECUTE_DONE',
          success: result.summary.success > 0,
          metadata: { ...result.summary, contractAddress: mintConfig.contractAddress },
        });

        return reply.send(result);
      } finally {
        await releaseLock(lockKey, lockId);
      }
    },
  );

  // ── GET /mint/history ───────────────────────────────────────────────────
  app.get<{ Querystring: { limit?: number; offset?: number; chainId?: number; status?: string } }>(
    '/mint/history', auth,
    async (req, reply) => {
      const { limit = 50, offset = 0, chainId, status } = req.query;

      const [records, total] = await Promise.all([
        prisma.mintRecord.findMany({
          where: {
            userId: req.userId,
            ...(chainId ? { chainId } : {}),
            ...(status ? { status } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: Math.min(limit, 200),
          skip: offset,
          select: {
            id: true, walletAddress: true, contractAddress: true,
            chainId: true, txHash: true, status: true, fnName: true,
            gasUsed: true, gasCostEth: true, mintPrice: true, quantity: true,
            errorMsg: true, blockNumber: true, createdAt: true,
          },
        }),
        prisma.mintRecord.count({ where: { userId: req.userId } }),
      ]);

      return reply.send({ records, total, limit, offset });
    },
  );

  // ── GET /mint/history/:id ───────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/mint/history/:id', auth,
    async (req, reply) => {
      const record = await prisma.mintRecord.findFirst({
        where: { id: req.params.id, userId: req.userId },
      });
      if (!record) return reply.code(404).send({ error: 'Record not found' });
      return reply.send(record);
    },
  );
}
