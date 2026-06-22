// packages/api/src/services/userService.ts
import { prisma } from '../plugins/db.js';

export async function getUserProfile(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: {
      accessKey: {
        select: { tier: true, features: true, status: true, expiresAt: true, activatedAt: true },
      },
      _count: {
        select: { wallets: true, schedules: true, mintHistory: true, nftHoldings: true },
      },
    },
  });
}

export async function updatePreferences(
  userId: string,
  prefs: Record<string, unknown>,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { preferences: true } });
  const merged = { ...(user?.preferences as object ?? {}), ...prefs };
  await prisma.user.update({ where: { id: userId }, data: { preferences: merged } });
}

export async function getUserMintStats(userId: string) {
  const [total, byStatus, totalSpent] = await Promise.all([
    prisma.mintRecord.count({ where: { userId } }),
    prisma.mintRecord.groupBy({ by: ['status'], where: { userId }, _count: true }),
    prisma.mintRecord.aggregate({
      where: { userId, status: 'success' },
      _sum: { gasCostEth: true, mintPrice: true },
    }),
  ]);

  return {
    totalMints: total,
    byStatus: Object.fromEntries(byStatus.map(s => [s.status, s._count])),
    totalGasSpent: totalSpent._sum.gasCostEth ?? 0,
    totalMintSpend: totalSpent._sum.mintPrice ?? 0,
  };
}
