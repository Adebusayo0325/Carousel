// packages/api/src/services/keyService.ts
// Admin-only access key lifecycle: generation, activation, validation, revocation.
// Keys are argon2id-hashed in the DB — the plaintext is shown ONCE at generation.

import crypto from 'crypto';
import argon2 from 'argon2';
import { prisma } from '../plugins/db.js';
import { Tier, TIER_FEATURES } from '@apex/core/types';
import type { AccessKey } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────────
// Key format: APEX-{tier3}-{24-random-hex-chars}
// e.g.  APEX-PRE-a3f84c902b1d7e...
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX_MAP: Record<Tier, string> = {
  [Tier.BASIC]: 'BAS',
  [Tier.PREMIUM]: 'PRE',
  [Tier.ENTERPRISE]: 'ENT',
};

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
  secret: Buffer.from(process.env.ARGON2_PEPPER ?? '00'.repeat(32), 'hex'),
};

export interface GeneratedKey {
  rawKey: string;         // Show ONCE — never stored
  keyId: string;
  tier: Tier;
  features: string[];
  durationDays: number;
  label?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate
// ─────────────────────────────────────────────────────────────────────────────

export async function generateAccessKey(opts: {
  tier: Tier;
  durationDays?: number;
  features?: string[];
  label?: string;
  adminId: string;
}): Promise<GeneratedKey> {
  const { tier, durationDays = 30, label, adminId } = opts;

  if (!process.env.ARGON2_PEPPER || process.env.ARGON2_PEPPER.length < 64) {
    throw new Error('ARGON2_PEPPER not configured — run npm run admin setup');
  }

  const tierPrefix = PREFIX_MAP[tier] ?? 'BAS';
  const randomPart = crypto.randomBytes(18).toString('hex'); // 36 hex chars
  const rawKey = `APEX-${tierPrefix}-${randomPart}`;
  const keyPrefix = rawKey.slice(0, 12); // APEX-PRE-a3f8

  const features = opts.features?.length
    ? opts.features
    : TIER_FEATURES[tier];

  const keyHash = await argon2.hash(rawKey, ARGON2_OPTIONS);

  const record = await prisma.accessKey.create({
    data: {
      keyHash,
      keyPrefix,
      tier,
      features,
      label: label ?? null,
      durationDays,
      createdBy: adminId,
      status: 'UNUSED',
    },
  });

  return { rawKey, keyId: record.id, tier, features, durationDays, label };
}

// ─────────────────────────────────────────────────────────────────────────────
// Activate (first use)
// ─────────────────────────────────────────────────────────────────────────────

export async function activateKey(rawKey: string): Promise<AccessKey | null> {
  const keyPrefix = rawKey.slice(0, 12);

  // Narrow candidates by prefix (fast index scan)
  const candidates = await prisma.accessKey.findMany({
    where: { keyPrefix, status: 'UNUSED' },
  });

  for (const candidate of candidates) {
    const valid = await argon2.verify(candidate.keyHash, rawKey, ARGON2_OPTIONS);
    if (!valid) continue;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + candidate.durationDays * 86_400_000);

    return prisma.accessKey.update({
      where: { id: candidate.id },
      data: { status: 'ACTIVE', activatedAt: now, expiresAt },
    });
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validate (every request)
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  keyId?: string;
  userId?: string;
  tier?: Tier;
  features?: string[];
  reason?: string;
}

export async function validateAccessKey(rawKey: string): Promise<ValidationResult> {
  if (!rawKey?.startsWith('APEX-')) {
    return { valid: false, reason: 'Invalid key format' };
  }

  const keyPrefix = rawKey.slice(0, 12);

  const candidates = await prisma.accessKey.findMany({
    where: { keyPrefix, status: { in: ['ACTIVE', 'UNUSED'] } },
    include: { user: true },
  });

  for (const candidate of candidates) {
    const valid = await argon2.verify(candidate.keyHash, rawKey, ARGON2_OPTIONS);
    if (!valid) continue;

    if (candidate.status === 'REVOKED') {
      return { valid: false, reason: 'Key revoked' };
    }
    if (candidate.expiresAt && candidate.expiresAt < new Date()) {
      await prisma.accessKey.update({ where: { id: candidate.id }, data: { status: 'EXPIRED' } });
      return { valid: false, reason: 'Key expired' };
    }

    return {
      valid: true,
      keyId: candidate.id,
      userId: candidate.user?.id,
      tier: candidate.tier as Tier,
      features: candidate.features,
    };
  }

  return { valid: false, reason: 'Key not found' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session token management
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_BYTES = 32;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function generateSessionToken(): string {
  return crypto.randomBytes(SESSION_BYTES).toString('hex');
}

export async function createSession(userId: string): Promise<string> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.user.update({
    where: { id: userId },
    data: { sessionToken: token, sessionExpiresAt: expiresAt },
  });

  return token;
}

export async function validateSession(token: string): Promise<{
  valid: boolean;
  userId?: string;
  tier?: Tier;
  features?: string[];
}> {
  if (!token || token.length < 64) return { valid: false };

  const user = await prisma.user.findUnique({
    where: { sessionToken: token },
    include: { accessKey: true },
  });

  if (!user) return { valid: false };
  if (!user.sessionExpiresAt || user.sessionExpiresAt < new Date()) {
    return { valid: false };
  }
  if (user.accessKey.status === 'REVOKED') return { valid: false };
  if (user.accessKey.expiresAt && user.accessKey.expiresAt < new Date()) return { valid: false };

  return {
    valid: true,
    userId: user.id,
    tier: user.tier as Tier,
    features: user.accessKey.features,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Revoke (admin only)
// ─────────────────────────────────────────────────────────────────────────────

export async function revokeKey(keyId: string, adminId: string, reason?: string): Promise<void> {
  await prisma.accessKey.update({
    where: { id: keyId },
    data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: `${adminId}: ${reason ?? 'admin action'}` },
  });

  // Invalidate the user's session immediately
  const user = await prisma.user.findFirst({ where: { accessKeyId: keyId } });
  if (user) {
    await prisma.user.update({
      where: { id: user.id },
      data: { sessionToken: null, sessionExpiresAt: null },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature gate check (enforced server-side on every endpoint)
// ─────────────────────────────────────────────────────────────────────────────

export function hasFeature(features: string[], feature: string): boolean {
  if (features.includes('*')) return true; // Enterprise wildcard
  return features.includes(feature);
}

export function requireFeature(features: string[], feature: string): void {
  if (!hasFeature(features, feature)) {
    throw Object.assign(new Error(`Feature '${feature}' not available on your plan. Upgrade to unlock.`), {
      statusCode: 403,
      code: 'FEATURE_GATED',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin listing
// ─────────────────────────────────────────────────────────────────────────────

export async function listKeys(filter?: {
  tier?: Tier;
  status?: string;
  limit?: number;
}) {
  return prisma.accessKey.findMany({
    where: {
      tier: filter?.tier,
      status: filter?.status,
    },
    include: { user: { select: { id: true, label: true, lastLoginAt: true } } },
    orderBy: { createdAt: 'desc' },
    take: filter?.limit ?? 100,
  });
}

export async function getKeyStats() {
  const [total, active, expired, revoked, byTier] = await Promise.all([
    prisma.accessKey.count(),
    prisma.accessKey.count({ where: { status: 'ACTIVE' } }),
    prisma.accessKey.count({ where: { status: 'EXPIRED' } }),
    prisma.accessKey.count({ where: { status: 'REVOKED' } }),
    prisma.accessKey.groupBy({ by: ['tier'], _count: true }),
  ]);

  return { total, active, expired, revoked, byTier };
}
