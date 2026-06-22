// packages/api/src/routes/portfolio.ts
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/authenticate.js';
import { requireFeatureHook } from '../middleware/tierGate.js';
import { prisma } from '../plugins/db.js';
import { getPortfolioQueue } from '../plugins/redis.js';

export async function portfolioRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const premiumAuth = { preHandler: [authenticate, requireFeatureHook('portfolio')] };

  // ── GET /portfolio ──────────────────────────────────────────────────────
  app.get<{ Querystring: { walletAddress?: string; chainId?: number; page?: number } }>(
    '/portfolio', premiumAuth,
    async (req, reply) => {
      const { walletAddress, chainId, page = 1 } = req.query;
      const take = 50;
      const skip = (page - 1) * take;

      const [holdings, total] = await Promise.all([
        prisma.nftHolding.findMany({
          where: {
            userId: req.userId,
            ...(walletAddress ? { walletAddress: { equals: walletAddress, mode: 'insensitive' } } : {}),
            ...(chainId ? { chainId } : {}),
          },
          orderBy: [{ floorPrice: 'desc' }, { createdAt: 'desc' }],
          take,
          skip,
        }),
        prisma.nftHolding.count({
          where: { userId: req.userId, ...(chainId ? { chainId } : {}) },
        }),
      ]);

      return reply.send({ holdings, total, page, pages: Math.ceil(total / take) });
    },
  );

  // ── POST /portfolio/sync ────────────────────────────────────────────────
  // Enqueue a background NFT sync job for the user's wallets
  app.post<{ Body: { walletAddresses?: string[]; chainIds?: number[] } }>(
    '/portfolio/sync', premiumAuth,
    async (req, reply) => {
      const queue = getPortfolioQueue();
      const job = await queue.add('sync', {
        userId: req.userId,
        walletAddresses: req.body.walletAddresses ?? [],
        chainIds: req.body.chainIds ?? [1, 8453, 42161, 10, 137],
      }, { attempts: 2, backoff: { type: 'fixed', delay: 5000 } });

      return reply.send({ jobId: job.id, status: 'queued' });
    },
  );

  // ── GET /portfolio/stats ────────────────────────────────────────────────
  app.get('/portfolio/stats', premiumAuth, async (req, reply) => {
    const holdings = await prisma.nftHolding.findMany({
      where: { userId: req.userId },
      select: { chainId: true, floorPrice: true, isListed: true, marketplace: true },
    });

    const totalEstimatedValue = holdings.reduce((s, h) => s + (h.floorPrice ?? 0), 0);
    const listedCount = holdings.filter(h => h.isListed).length;
    const byChain = holdings.reduce((acc, h) => {
      acc[h.chainId] = (acc[h.chainId] ?? 0) + 1;
      return acc;
    }, {} as Record<number, number>);

    return reply.send({
      totalNFTs: holdings.length,
      totalEstimatedValue,
      listedCount,
      unlistedCount: holdings.length - listedCount,
      byChain,
    });
  });
}
