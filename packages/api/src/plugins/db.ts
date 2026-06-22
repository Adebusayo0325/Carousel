// packages/api/src/plugins/db.ts
import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Singleton prevents connection pool exhaustion in dev hot-reload
export const prisma: PrismaClient =
  globalThis.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'warn', 'error']
      : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;
}

export async function connectDB(): Promise<void> {
  await prisma.$connect();
}

export async function disconnectDB(): Promise<void> {
  await prisma.$disconnect();
}
