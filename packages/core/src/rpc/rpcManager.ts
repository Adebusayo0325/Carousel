// packages/core/src/rpc/rpcManager.ts
// Multi-RPC failover with health scoring, circuit breakers, and WebSocket events.
// Health scores decay on errors and recover on success — bad RPCs fall to the back.

import { ethers } from 'ethers';
import { getChain, SOLANA_CONFIG } from '../chains/registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface EndpointState {
  url: string;
  score: number;          // 0–100; higher = preferred
  latencyMs: number;
  errorCount: number;
  successCount: number;
  lastError?: string;
  lastChecked: number;
  isCircuitOpen: boolean; // open = skip this endpoint temporarily
  circuitOpenAt?: number;
}

const CIRCUIT_RESET_MS = 60_000;     // retry a tripped circuit after 60 s
const HEALTH_CHECK_INTERVAL = 30_000; // recheck all endpoints every 30 s
const ERROR_PENALTY = 15;            // score drop per error
const SUCCESS_REWARD = 5;            // score gain per success
const LATENCY_PENALTY_PER_100MS = 1; // score drop per 100 ms of latency

// ─────────────────────────────────────────────────────────────────────────────
// Per-chain endpoint pools
// ─────────────────────────────────────────────────────────────────────────────

const _pools = new Map<number, EndpointState[]>();
const _wsProviders = new Map<number, ethers.WebSocketProvider>();
const _httpProviderCache = new Map<string, ethers.JsonRpcProvider>();

function getPool(chainId: number): EndpointState[] {
  if (!_pools.has(chainId)) {
    const chain = getChain(chainId);
    const states: EndpointState[] = chain.rpcUrls.map(url => ({
      url,
      score: 100,
      latencyMs: 0,
      errorCount: 0,
      successCount: 0,
      lastChecked: 0,
      isCircuitOpen: false,
    }));
    _pools.set(chainId, states);
  }
  return _pools.get(chainId)!;
}

function getBestEndpoint(chainId: number): EndpointState | null {
  const pool = getPool(chainId);
  const now = Date.now();

  // Reset circuits that have cooled down
  for (const ep of pool) {
    if (ep.isCircuitOpen && ep.circuitOpenAt && now - ep.circuitOpenAt > CIRCUIT_RESET_MS) {
      ep.isCircuitOpen = false;
      ep.score = Math.max(10, ep.score); // give a fresh (low) chance
    }
  }

  const available = pool.filter(ep => !ep.isCircuitOpen && ep.score > 0);
  if (available.length === 0) {
    // All circuits open — try the best anyway (last resort)
    return pool.sort((a, b) => b.score - a.score)[0] ?? null;
  }

  // Weighted random selection biased toward high-score endpoints
  const sorted = available.sort((a, b) => b.score - a.score);

  // Use the top endpoint 70% of the time; fall through for load distribution
  if (Math.random() < 0.7) return sorted[0];
  return sorted[Math.floor(Math.random() * Math.min(3, sorted.length))];
}

function recordSuccess(chainId: number, url: string, latencyMs: number): void {
  const pool = getPool(chainId);
  const ep = pool.find(e => e.url === url);
  if (!ep) return;
  ep.latencyMs = latencyMs;
  ep.successCount++;
  ep.isCircuitOpen = false;
  const latencyPenalty = Math.floor(latencyMs / 100) * LATENCY_PENALTY_PER_100MS;
  ep.score = Math.min(100, ep.score + SUCCESS_REWARD - latencyPenalty);
  ep.lastChecked = Date.now();
}

function recordError(chainId: number, url: string, error: string): void {
  const pool = getPool(chainId);
  const ep = pool.find(e => e.url === url);
  if (!ep) return;
  ep.errorCount++;
  ep.lastError = error;
  ep.score = Math.max(0, ep.score - ERROR_PENALTY);
  ep.lastChecked = Date.now();

  // Trip the circuit if score hits 0 or 3+ consecutive errors
  if (ep.score === 0 || ep.errorCount % 3 === 0) {
    ep.isCircuitOpen = true;
    ep.circuitOpenAt = Date.now();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the best available HTTP provider for a chain.
 * Falls back through the endpoint pool on failures.
 */
export async function getProvider(chainId: number): Promise<ethers.JsonRpcProvider> {
  const ep = getBestEndpoint(chainId);
  if (!ep) throw new Error(`No RPC endpoints available for chain ${chainId}`);

  const cacheKey = `${chainId}:${ep.url}`;
  if (!_httpProviderCache.has(cacheKey)) {
    _httpProviderCache.set(cacheKey, new ethers.JsonRpcProvider(ep.url, chainId, {
      staticNetwork: true,
    }));
  }
  return _httpProviderCache.get(cacheKey)!;
}

/**
 * Execute a call with automatic RPC failover.
 * On failure, marks the endpoint and retries with the next best.
 */
export async function withFailover<T>(
  chainId: number,
  fn: (provider: ethers.JsonRpcProvider) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  const tried = new Set<string>();
  let lastError: Error = new Error('No RPC available');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ep = getBestEndpoint(chainId);
    if (!ep || tried.has(ep.url)) break;
    tried.add(ep.url);

    const cacheKey = `${chainId}:${ep.url}`;
    const provider = _httpProviderCache.get(cacheKey) ??
      new ethers.JsonRpcProvider(ep.url, chainId, { staticNetwork: true });
    _httpProviderCache.set(cacheKey, provider);

    const start = Date.now();
    try {
      const result = await fn(provider);
      recordSuccess(chainId, ep.url, Date.now() - start);
      return result;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      recordError(chainId, ep.url, msg);
      lastError = err as Error;

      // Don't retry on contract-level reverts — only on RPC/network errors
      if (
        msg.includes('execution reverted') ||
        msg.includes('CALL_EXCEPTION') ||
        msg.includes('insufficient funds')
      ) {
        throw err;
      }
    }
  }

  throw lastError;
}

/**
 * Get or create a WebSocket provider for real-time events.
 */
export function getWebSocketProvider(chainId: number): ethers.WebSocketProvider | null {
  if (_wsProviders.has(chainId)) return _wsProviders.get(chainId)!;

  const pool = getPool(chainId);
  const wsEndpoint = pool.find(ep => ep.url.startsWith('wss://'));
  if (!wsEndpoint) return null;

  try {
    const wsp = new ethers.WebSocketProvider(wsEndpoint.url, chainId);
    wsp.on('error', () => {
      _wsProviders.delete(chainId);
      recordError(chainId, wsEndpoint.url, 'WebSocket error');
    });
    _wsProviders.set(chainId, wsp);
    return wsp;
  } catch {
    return null;
  }
}

/**
 * Solana connection with failover
 */
export async function getSolanaConnection() {
  const { Connection, clusterApiUrl } = await import('@solana/web3.js');
  const urls = SOLANA_CONFIG.rpcUrls.filter(Boolean);
  if (urls.length === 0) return new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

  for (const url of urls) {
    try {
      const conn = new Connection(url, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60_000,
      });
      // Quick health check
      await conn.getSlot();
      return conn;
    } catch { continue; }
  }

  // Last resort — public endpoint
  return new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Health monitoring
// ─────────────────────────────────────────────────────────────────────────────

async function checkEndpointHealth(chainId: number, ep: EndpointState): Promise<void> {
  const provider = new ethers.JsonRpcProvider(ep.url, chainId, { staticNetwork: true });
  const start = Date.now();
  try {
    const block = await Promise.race([
      provider.getBlockNumber(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    recordSuccess(chainId, ep.url, Date.now() - start);
  } catch (err) {
    recordError(chainId, ep.url, (err as Error).message);
  }
}

export async function runHealthChecks(): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const [chainId, pool] of _pools.entries()) {
    for (const ep of pool) {
      tasks.push(checkEndpointHealth(chainId, ep));
    }
  }
  await Promise.allSettled(tasks);
}

export function startHealthMonitor(): NodeJS.Timeout {
  return setInterval(() => {
    runHealthChecks().catch(() => {});
  }, HEALTH_CHECK_INTERVAL);
}

export function getEndpointStats(chainId: number): EndpointState[] {
  return [...(getPool(chainId))].sort((a, b) => b.score - a.score);
}

export function getRpcScoreboard(): Record<number, EndpointState[]> {
  const result: Record<number, EndpointState[]> = {};
  for (const [chainId, pool] of _pools.entries()) {
    result[chainId] = [...pool].sort((a, b) => b.score - a.score);
  }
  return result;
}
