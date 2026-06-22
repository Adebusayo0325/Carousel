#!/usr/bin/env node
// packages/cli/src/index.ts
// Admin CLI for ApexMint Pro — the only way to generate/revoke access keys.

import { Command } from 'commander';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const program = new Command();
const API = process.env.APEX_API_URL ?? 'http://localhost:3000/api/v1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function adminHeaders() {
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN not set — add it to .env');
  return {
    'Content-Type': 'application/json',
    'x-admin-token': ADMIN_TOKEN,
  };
}

async function apiGet(path: string) {
  const res = await fetch(`${API}${path}`, { headers: adminHeaders() });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost(path: string, body: object) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiDelete(path: string, body?: object) {
  const res = await fetch(`${API}${path}`, {
    method: 'DELETE',
    headers: adminHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

function print(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

function box(title: string, lines: string[]) {
  const width = Math.max(title.length, ...lines.map(l => l.length)) + 4;
  const border = '─'.repeat(width);
  console.log(`┌${border}┐`);
  console.log(`│  ${title.padEnd(width - 2)}│`);
  console.log(`├${border}┤`);
  lines.forEach(l => console.log(`│  ${l.padEnd(width - 2)}│`));
  console.log(`└${border}┘`);
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`${prompt} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

program
  .name('apexmint')
  .description('ApexMint Pro admin CLI')
  .version('1.0.0');

// ── generate-key ────────────────────────────────────────────────────────────
program
  .command('generate-key')
  .description('Generate a new access key')
  .requiredOption('-t, --tier <tier>', 'Tier: BASIC | PREMIUM | ENTERPRISE')
  .option('-d, --days <number>', 'Duration in days', '30')
  .option('-l, --label <string>', 'Human label for this key')
  .option('-f, --features <list>', 'Comma-separated feature overrides')
  .action(async (opts) => {
    const tier = opts.tier.toUpperCase();
    const durationDays = parseInt(opts.days);
    const features = opts.features?.split(',').map((s: string) => s.trim());

    if (!['BASIC', 'PREMIUM', 'ENTERPRISE'].includes(tier)) {
      console.error('❌ Invalid tier. Use: BASIC | PREMIUM | ENTERPRISE');
      process.exit(1);
    }

    console.log(`\n🔑 Generating ${tier} key (${durationDays}d)…\n`);

    try {
      const result = await apiPost('/admin/keys/generate', {
        tier,
        durationDays,
        label: opts.label,
        features,
      }) as Record<string, unknown>;

      box('⚠️  ACCESS KEY GENERATED — STORE SECURELY — SHOWN ONCE', [
        `Key:      ${result.rawKey}`,
        `ID:       ${result.keyId}`,
        `Tier:     ${result.tier}`,
        `Duration: ${result.durationDays} days (starts on first login)`,
        `Label:    ${result.label ?? 'none'}`,
        `Features: ${(result.features as string[]).join(', ')}`,
      ]);
      console.log('\n⚠️  This key will NOT be shown again. Copy it now.\n');
    } catch (e) {
      console.error('❌', (e as Error).message);
      process.exit(1);
    }
  });

// ── list-keys ───────────────────────────────────────────────────────────────
program
  .command('list-keys')
  .description('List all access keys')
  .option('-t, --tier <tier>', 'Filter by tier')
  .option('-s, --status <status>', 'Filter by status: UNUSED|ACTIVE|EXPIRED|REVOKED')
  .option('-l, --limit <n>', 'Max results', '50')
  .action(async (opts) => {
    const params = new URLSearchParams();
    if (opts.tier)   params.set('tier', opts.tier.toUpperCase());
    if (opts.status) params.set('status', opts.status.toUpperCase());
    if (opts.limit)  params.set('limit', opts.limit);

    try {
      const data = await apiGet(`/admin/keys?${params}`) as { keys: Array<Record<string, unknown>> };
      if (data.keys.length === 0) { console.log('No keys found.'); return; }

      console.log(`\n${'ID'.padEnd(28)} ${'PREFIX'.padEnd(14)} ${'TIER'.padEnd(12)} ${'STATUS'.padEnd(10)} ${'LABEL'.padEnd(20)} EXPIRES`);
      console.log('─'.repeat(110));
      for (const k of data.keys) {
        const exp = k.expiresAt ? new Date(k.expiresAt as string).toLocaleDateString() : 'not activated';
        const user = (k.user as { label?: string } | null)?.label ?? '—';
        console.log(
          `${(k.id as string).padEnd(28)} ${(k.keyPrefix as string).padEnd(14)} ${(k.tier as string).padEnd(12)} ` +
          `${(k.status as string).padEnd(10)} ${user.padEnd(20)} ${exp}`,
        );
      }
      console.log(`\nTotal: ${data.keys.length}\n`);
    } catch (e) {
      console.error('❌', (e as Error).message);
      process.exit(1);
    }
  });

// ── revoke-key ───────────────────────────────────────────────────────────────
program
  .command('revoke-key <keyId>')
  .description('Revoke an access key immediately (kills active session)')
  .option('-r, --reason <string>', 'Revocation reason')
  .action(async (keyId, opts) => {
    const ok = await confirm(`⚠️  Revoke key ${keyId}? This will immediately end the user's session.`);
    if (!ok) { console.log('Cancelled.'); return; }

    try {
      const result = await apiDelete(`/admin/keys/${keyId}`, { reason: opts.reason });
      console.log('✅', (result as { message: string }).message);
    } catch (e) {
      console.error('❌', (e as Error).message);
      process.exit(1);
    }
  });

// ── stats ────────────────────────────────────────────────────────────────────
program
  .command('stats')
  .description('Show global platform statistics')
  .action(async () => {
    try {
      const data = await apiGet('/admin/stats') as Record<string, unknown>;
      const keys = data.keys as Record<string, unknown>;
      const users = data.users as Record<string, unknown>;
      const mints = data.mints as Record<string, unknown>;

      box('ApexMint Pro — Platform Stats', [
        `Keys:      ${keys.total} total | ${keys.active} active | ${keys.expired} expired | ${keys.revoked} revoked`,
        `Users:     ${users.total} registered`,
        `Mints:     ${mints.total} total`,
      ]);
    } catch (e) {
      console.error('❌', (e as Error).message);
      process.exit(1);
    }
  });

// ── users ────────────────────────────────────────────────────────────────────
program
  .command('users')
  .description('List all users')
  .option('-l, --limit <n>', 'Max results', '25')
  .action(async (opts) => {
    try {
      const data = await apiGet(`/admin/users?limit=${opts.limit}`) as { users: Array<Record<string, unknown>>; total: number };
      console.log(`\n${'USER ID'.padEnd(30)} ${'LABEL'.padEnd(20)} ${'TIER'.padEnd(12)} ${'WALLETS'.padEnd(9)} ${'MINTS'.padEnd(8)} LAST LOGIN`);
      console.log('─'.repeat(100));
      for (const u of data.users) {
        const _count = u._count as { wallets: number; mintHistory: number };
        const lastLogin = u.lastLoginAt ? new Date(u.lastLoginAt as string).toLocaleString() : 'Never';
        console.log(
          `${(u.id as string).padEnd(30)} ${(u.label as string ?? '—').padEnd(20)} ` +
          `${(u.tier as string).padEnd(12)} ${String(_count.wallets).padEnd(9)} ${String(_count.mintHistory).padEnd(8)} ${lastLogin}`,
        );
      }
      console.log(`\nTotal: ${data.total}\n`);
    } catch (e) {
      console.error('❌', (e as Error).message);
      process.exit(1);
    }
  });

// ── health ───────────────────────────────────────────────────────────────────
program
  .command('health')
  .description('Check API and RPC health')
  .action(async () => {
    try {
      const health = await fetch(`${API.replace('/api/v1', '')}/health`).then(r => r.json()) as Record<string, unknown>;
      console.log('✅ API:', health.status, '| version:', health.version);

      const rpc = await apiGet('/admin/rpc-health') as Record<number, Array<{ url: string; score: number; latencyMs: number }>>;
      console.log('\nRPC Health:');
      for (const [chainId, endpoints] of Object.entries(rpc)) {
        for (const ep of endpoints.slice(0, 2)) {
          const bar = '█'.repeat(Math.round(ep.score / 10)) + '░'.repeat(10 - Math.round(ep.score / 10));
          console.log(`  Chain ${chainId}: [${bar}] ${ep.score}/100 | ${ep.latencyMs}ms | ${ep.url}`);
        }
      }
    } catch (e) {
      console.error('❌', (e as Error).message);
      process.exit(1);
    }
  });

program.parse();
