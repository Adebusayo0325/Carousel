// packages/api/src/plugins/redis.ts
import { Redis } from 'ioredis';
import { Queue, QueueOptions } from 'bullmq';

// ─────────────────────────────────────────────────────────────────────────────
// Redis connection singleton
// ─────────────────────────────────────────────────────────────────────────────

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null, // required for BullMQ
      enableReadyCheck: false,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });
    _redis.on('error', (err) => {
      if (process.env.NODE_ENV !== 'test') {
        console.error('[Redis] Connection error:', err.message);
      }
    });
  }
  return _redis;
}

export async function disconnectRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BullMQ queue definitions
// ─────────────────────────────────────────────────────────────────────────────

export const QUEUE_NAMES = {
  MINT: 'apex:mint',
  SCHEDULE: 'apex:schedule',
  PORTFOLIO_SYNC: 'apex:portfolio-sync',
  RPC_HEALTH: 'apex:rpc-health',
} as const;

const DEFAULT_QUEUE_OPTS: Partial<QueueOptions> = {
  connection: undefined, // set below after Redis is ready
  defaultJobOptions: {
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  },
};

function makeQueue(name: string): Queue {
  return new Queue(name, {
    ...DEFAULT_QUEUE_OPTS,
    connection: getRedis(),
  });
}

// Lazy-initialized queues
let _mintQueue: Queue | null = null;
let _scheduleQueue: Queue | null = null;
let _portfolioQueue: Queue | null = null;

export function getMintQueue(): Queue {
  return (_mintQueue ??= makeQueue(QUEUE_NAMES.MINT));
}
export function getScheduleQueue(): Queue {
  return (_scheduleQueue ??= makeQueue(QUEUE_NAMES.SCHEDULE));
}
export function getPortfolioQueue(): Queue {
  return (_portfolioQueue ??= makeQueue(QUEUE_NAMES.PORTFOLIO_SYNC));
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit helpers (token bucket per user)
// ─────────────────────────────────────────────────────────────────────────────

const RATE_LIMIT_PREFIX = 'rl:';

export async function checkRateLimit(
  userId: string,
  action: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const redis = getRedis();
  const key = `${RATE_LIMIT_PREFIX}${userId}:${action}`;

  const pipe = redis.pipeline();
  pipe.incr(key);
  pipe.ttl(key);
  const results = await pipe.exec() as [[null, number], [null, number]];

  const count = results[0][1];
  const ttl = results[1][1];

  if (ttl < 0) {
    await redis.expire(key, windowSeconds);
  }

  const resetAt = Date.now() + (ttl > 0 ? ttl * 1000 : windowSeconds * 1000);

  if (count > maxRequests) {
    return { allowed: false, remaining: 0, resetAt };
  }

  return { allowed: true, remaining: maxRequests - count, resetAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Distributed lock (prevent duplicate mints)
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_PREFIX = 'lock:';

export async function acquireLock(
  resource: string,
  ttlMs = 30_000,
): Promise<string | null> {
  const redis = getRedis();
  const lockId = Math.random().toString(36).slice(2) + Date.now();
  const key = `${LOCK_PREFIX}${resource}`;
  const result = await redis.set(key, lockId, 'PX', ttlMs, 'NX');
  return result === 'OK' ? lockId : null;
}

export async function releaseLock(resource: string, lockId: string): Promise<void> {
  const redis = getRedis();
  const key = `${LOCK_PREFIX}${resource}`;
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else return 0 end
  `;
  await redis.eval(script, 1, key, lockId);
}
