// packages/api/src/services/scheduleService.ts
// Persistent scheduler: time-based, phase-polling, or hybrid.
// Jobs live in BullMQ (Redis) + Postgres. On worker restart, all PENDING
// schedules are re-queued — no ghost schedules, no silent failures.

import { prisma } from '../plugins/db.js';
import { getMintQueue, getScheduleQueue, acquireLock, releaseLock } from '../plugins/redis.js';
import { SCHEDULE_LIMITS, Tier } from '@apex/core/types';
import type { MintConfig } from '@apex/core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Create schedule
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateScheduleInput {
  userId: string;
  userTier: Tier;
  contractAddress: string;
  chainId: number;
  mintConfig: MintConfig;
  walletIds: string[];
  mintTime?: string;           // ISO string — null = immediate
  waitForPhase?: boolean;      // poll until public phase opens
  phaseCheckIntervalMs?: number;
  phaseMaxWaitMs?: number;
}

export async function createSchedule(input: CreateScheduleInput) {
  const {
    userId, userTier, contractAddress, chainId, mintConfig,
    walletIds, mintTime, waitForPhase = false,
    phaseCheckIntervalMs = 5_000, phaseMaxWaitMs = 3_600_000,
  } = input;

  // Tier: concurrent schedule limit
  const active = await prisma.schedule.count({ where: { userId, status: { in: ['PENDING', 'RUNNING'] } } });
  const limit = SCHEDULE_LIMITS[userTier];
  if (active >= limit) {
    throw Object.assign(
      new Error(`Schedule limit reached (${limit} for ${userTier} tier). Cancel a pending schedule or upgrade.`),
      { statusCode: 403, code: 'SCHEDULE_LIMIT' },
    );
  }

  const schedule = await prisma.schedule.create({
    data: {
      userId,
      contractAddress,
      chainId,
      chain: mintConfig.chainId === -1 ? 'solana' : 'evm', // -1 = Solana sentinel
      mintTime: mintTime ? new Date(mintTime) : null,
      waitForPhase,
      phaseCheckIntervalMs,
      phaseMaxWaitMs,
      quantity: mintConfig.quantity,
      mintPrice: mintConfig.mintPrice,
      status: 'PENDING',
      config: mintConfig as object,
      walletAddresses: walletIds,
    },
  });

  // Enqueue the job
  const jobId = await enqueueSchedule(schedule.id, userId, mintConfig, walletIds, mintTime, waitForPhase);

  await prisma.schedule.update({
    where: { id: schedule.id },
    data: { jobId },
  });

  return { ...schedule, jobId };
}

async function enqueueSchedule(
  scheduleId: string,
  userId: string,
  mintConfig: MintConfig,
  walletIds: string[],
  mintTime: string | undefined,
  waitForPhase: boolean,
): Promise<string> {
  const queue = waitForPhase ? getScheduleQueue() : getMintQueue();

  const delay = mintTime
    ? Math.max(0, new Date(mintTime).getTime() - Date.now() - 200) // 200ms early to account for latency
    : 0;

  const job = await queue.add(
    waitForPhase ? 'phase-poll' : 'mint',
    {
      type: waitForPhase ? 'scheduled-phase' : mintTime ? 'scheduled' : 'immediate',
      userId,
      scheduleId,
      mintConfig,
      walletIds,
    },
    {
      delay,
      jobId: `schedule:${scheduleId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  );

  return job.id ?? scheduleId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel schedule
// ─────────────────────────────────────────────────────────────────────────────

export async function cancelSchedule(scheduleId: string, userId: string): Promise<void> {
  const schedule = await prisma.schedule.findFirst({ where: { id: scheduleId, userId } });
  if (!schedule) throw Object.assign(new Error('Schedule not found'), { statusCode: 404 });
  if (!['PENDING', 'RUNNING'].includes(schedule.status)) {
    throw Object.assign(new Error(`Cannot cancel a ${schedule.status} schedule`), { statusCode: 400 });
  }

  // Remove from BullMQ
  if (schedule.jobId) {
    try {
      const mintQueue = getMintQueue();
      const schedQueue = getScheduleQueue();
      const [j1, j2] = await Promise.all([
        mintQueue.getJob(schedule.jobId),
        schedQueue.getJob(schedule.jobId),
      ]);
      await j1?.remove();
      await j2?.remove();
    } catch { /* job may have already run */ }
  }

  await prisma.schedule.update({
    where: { id: scheduleId },
    data: { status: 'CANCELLED' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// List schedules
// ─────────────────────────────────────────────────────────────────────────────

export async function listSchedules(userId: string, status?: string) {
  return prisma.schedule.findMany({
    where: {
      userId,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true, contractAddress: true, chainId: true, chain: true,
      mintTime: true, waitForPhase: true, quantity: true, mintPrice: true,
      status: true, jobId: true, errorMsg: true, results: true,
      createdAt: true, completedAt: true,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Recovery: re-queue PENDING schedules on worker startup
// Called by the worker process on boot to survive restarts.
// ─────────────────────────────────────────────────────────────────────────────

export async function recoverPendingSchedules(): Promise<number> {
  const lockId = await acquireLock('schedule-recovery', 60_000);
  if (!lockId) return 0; // Another worker is recovering

  try {
    const pending = await prisma.schedule.findMany({
      where: { status: 'PENDING' },
    });

    let recovered = 0;
    for (const s of pending) {
      try {
        const mintConfig = s.config as MintConfig;
        const mintTime = s.mintTime?.toISOString();
        const walletIds = s.walletAddresses;

        // Check if job still exists in queue
        const existingJob = s.jobId ? await getMintQueue().getJob(s.jobId).catch(() => null) : null;
        if (existingJob) continue; // Already in queue

        // Re-enqueue
        const jobId = await enqueueSchedule(
          s.id, s.userId, mintConfig, walletIds,
          mintTime, s.waitForPhase,
        );
        await prisma.schedule.update({ where: { id: s.id }, data: { jobId } });
        recovered++;
      } catch (err) {
        console.error(`[Recovery] Failed to recover schedule ${s.id}:`, (err as Error).message);
      }
    }

    console.info(`[Recovery] Re-queued ${recovered}/${pending.length} pending schedules`);
    return recovered;
  } finally {
    await releaseLock('schedule-recovery', lockId);
  }
}
