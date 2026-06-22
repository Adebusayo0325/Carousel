// packages/worker/src/worker.ts
// BullMQ worker — handles mint jobs and phase-polling schedules.
// Called recoverPendingSchedules() on startup so no schedules are lost across restarts.

import { Worker, type Job } from 'bullmq';
import { getRedis } from '../../api/src/plugins/redis.js';
import { QUEUE_NAMES } from '../../api/src/plugins/redis.js';
import { connectDB } from '../../api/src/plugins/db.js';
import { recoverPendingSchedules } from '../../api/src/services/scheduleService.js';
import { startHealthMonitor } from '@apex/core/rpc/rpcManager';
import { processMintJob } from './processors/mintProcessor.js';
import { processScheduleJob } from './processors/scheduleProcessor.js';
import { processPortfolioSync } from './processors/portfolioProcessor.js';

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 10);

async function main() {
  console.info('[Worker] Connecting to DB and Redis…');
  await connectDB();
  startHealthMonitor();

  // ── Recover schedules that survived restarts ─────────────────────────────
  const recovered = await recoverPendingSchedules();
  console.info(`[Worker] Recovered ${recovered} pending schedules`);

  // ── Mint worker ──────────────────────────────────────────────────────────
  const mintWorker = new Worker(
    QUEUE_NAMES.MINT,
    async (job: Job) => processMintJob(job),
    {
      connection: getRedis(),
      concurrency: CONCURRENCY,
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 200 },
    },
  );

  // ── Schedule (phase-poll) worker ─────────────────────────────────────────
  const scheduleWorker = new Worker(
    QUEUE_NAMES.SCHEDULE,
    async (job: Job) => processScheduleJob(job),
    {
      connection: getRedis(),
      concurrency: Math.ceil(CONCURRENCY / 2),
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  );

  // ── Portfolio sync worker ────────────────────────────────────────────────
  const portfolioWorker = new Worker(
    QUEUE_NAMES.PORTFOLIO_SYNC,
    async (job: Job) => processPortfolioSync(job),
    {
      connection: getRedis(),
      concurrency: 5,
    },
  );

  // ── Event logging ────────────────────────────────────────────────────────
  for (const [worker, name] of [[mintWorker, 'mint'], [scheduleWorker, 'schedule'], [portfolioWorker, 'portfolio']] as const) {
    worker.on('completed', (job) => {
      console.info(`[${name}] ✅ Job ${job.id} completed`);
    });
    worker.on('failed', (job, err) => {
      console.error(`[${name}] ❌ Job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts.attempts}): ${err.message}`);
    });
    worker.on('error', (err) => {
      console.error(`[${name}] Worker error:`, err.message);
    });
  }

  console.info(`[Worker] 🚀 Running (concurrency=${CONCURRENCY})`);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async () => {
    console.info('[Worker] Shutting down gracefully…');
    await Promise.all([
      mintWorker.close(),
      scheduleWorker.close(),
      portfolioWorker.close(),
    ]);
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('[Worker] Fatal startup error:', err);
  process.exit(1);
});
