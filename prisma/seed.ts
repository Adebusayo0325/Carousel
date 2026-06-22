// prisma/seed.ts — development only, never run in production
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import crypto from 'crypto';

const prisma = new PrismaClient();

const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  secret: Buffer.from(process.env.ARGON2_PEPPER ?? '00'.repeat(32), 'hex'),
};

async function main() {
  console.log('🌱 Seeding dev database…');

  // Create a PREMIUM dev key
  const rawKey = 'APEX-PRE-devkey00000000000000000000000';
  const keyHash = await argon2.hash(rawKey, ARGON2_OPTS);

  const accessKey = await prisma.accessKey.upsert({
    where: { keyHash },
    update: {},
    create: {
      keyHash,
      keyPrefix: rawKey.slice(0, 12),
      tier: 'PREMIUM',
      features: ['evm-mint', 'solana-mint', 'multi-wallet', 'scheduling', 'portfolio', 'flashbots', 'jito', 'auto-list', 'risk-engine'],
      status: 'ACTIVE',
      activatedAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 86_400_000), // 1 year
      durationDays: 365,
      createdBy: 'seed',
      label: 'Dev key',
    },
  });

  const token = crypto.randomBytes(32).toString('hex');

  const user = await prisma.user.upsert({
    where: { accessKeyId: accessKey.id },
    update: {},
    create: {
      accessKeyId: accessKey.id,
      tier: 'PREMIUM',
      label: 'Dev User',
      sessionToken: token,
      sessionExpiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  console.log(`
✅ Dev seed complete

  Access key : ${rawKey}
  User ID    : ${user.id}
  Session    : ${token}

  POST /api/v1/auth/login with { "accessKey": "${rawKey}" }
  `);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
