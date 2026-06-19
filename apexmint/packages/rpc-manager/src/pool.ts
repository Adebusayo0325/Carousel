/**
 * RpcPool — multi-endpoint failover, health-weighted load balancing.
 *
 * Requirements: "No multi-RPC failover, dynamic fees, bundles ..." (the failover
 * half), "RPC health scoring", "priority RPCs".
 *
 * Design:
 *   • A `Transport` is injected: `(url, request) => Promise<response>`. Real
 *     deployments pass an HTTP JSON-RPC transport; tests pass a fake. The pool
 *     itself contains ZERO network code, so failover logic is fully testable.
 *   • Each endpoint has an EndpointHealth + CircuitBreaker.
 *   • `send` tries endpoints best-first (priority, then health), skipping
 *     open breakers, until one succeeds or all are exhausted — returning a
 *     Result, never a silent rejection.
 */

import { Errors, err, ok, type AppError, type Result } from '@apexmint/core';
import { CircuitBreaker, defaultBreakerConfig, type BreakerConfig } from './circuit-breaker.js';
import { EndpointHealth, defaultHealthConfig, type HealthConfig } from './health.js';

export interface JsonRpcRequest {
  readonly method: string;
  readonly params?: readonly unknown[];
}

export type Transport = (url: string, request: JsonRpcRequest) => Promise<unknown>;

export interface EndpointConfig {
  readonly url: string;
  /** Lower number = higher priority (tried first). Default 100. */
  readonly priority?: number;
  /** Premium/priority pool flag, surfaced for tier gating + metrics. */
  readonly premium?: boolean;
}

export interface PoolConfig {
  readonly breaker?: BreakerConfig;
  readonly health?: HealthConfig;
  /** Max endpoints to attempt per send before giving up. Default = all. */
  readonly maxAttempts?: number;
  readonly now?: () => number;
}

interface Endpoint {
  readonly url: string;
  readonly priority: number;
  readonly premium: boolean;
  readonly health: EndpointHealth;
  readonly breaker: CircuitBreaker;
}

export interface SendOutcome {
  readonly result: unknown;
  readonly endpoint: string;
  readonly attempts: number;
  readonly latencyMs: number;
}

export class RpcPool {
  readonly #endpoints: Endpoint[];
  readonly #transport: Transport;
  readonly #maxAttempts: number;
  readonly #now: () => number;

  constructor(endpoints: readonly EndpointConfig[], transport: Transport, config: PoolConfig = {}) {
    if (endpoints.length === 0) {
      throw new Error('RpcPool requires at least one endpoint');
    }
    const breakerCfg = config.breaker ?? defaultBreakerConfig();
    const healthCfg = config.health ?? defaultHealthConfig();
    this.#now = config.now ?? Date.now;
    this.#endpoints = endpoints.map((e) => ({
      url: e.url,
      priority: e.priority ?? 100,
      premium: e.premium ?? false,
      health: new EndpointHealth(e.url, healthCfg),
      breaker: new CircuitBreaker(breakerCfg, this.#now),
    }));
    this.#transport = transport;
    this.#maxAttempts = config.maxAttempts ?? endpoints.length;
  }

  /** Endpoints eligible right now (breaker not open), ordered best-first. */
  #orderedAvailable(): Endpoint[] {
    return this.#endpoints
      .filter((e) => e.breaker.canRequest())
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return b.health.score() - a.health.score();
      });
  }

  /**
   * Send a JSON-RPC request with failover. Returns the first success or an
   * aggregated upstream error if every eligible endpoint failed.
   */
  async send(request: JsonRpcRequest): Promise<Result<SendOutcome, AppError>> {
    const candidates = this.#orderedAvailable();
    if (candidates.length === 0) {
      return err(
        Errors.upstream('ALL_BREAKERS_OPEN', 'All RPC endpoints are circuit-broken', {
          retriable: true,
          details: { endpoints: this.#endpoints.length },
        }),
      );
    }

    const errorsSeen: string[] = [];
    let attempts = 0;
    for (const endpoint of candidates) {
      if (attempts >= this.#maxAttempts) break;
      attempts += 1;
      const start = this.#now();
      try {
        const result = await this.#transport(endpoint.url, request);
        const latencyMs = this.#now() - start;
        endpoint.health.recordSuccess(latencyMs);
        endpoint.breaker.recordSuccess();
        return ok({ result, endpoint: endpoint.url, attempts, latencyMs });
      } catch (cause) {
        endpoint.health.recordFailure();
        endpoint.breaker.recordFailure();
        errorsSeen.push(`${redactUrl(endpoint.url)}: ${(cause as Error).message ?? 'error'}`);
      }
    }

    return err(
      Errors.upstream('ALL_ENDPOINTS_FAILED', `All ${attempts} RPC attempt(s) failed`, {
        retriable: true,
        details: { errors: errorsSeen },
      }),
    );
  }

  /** Health snapshot for observability / RPC health scoring dashboards. */
  health(): Array<{ url: string; score: number; latencyMs: number | null; successRate: number; breaker: string; premium: boolean }> {
    return this.#endpoints.map((e) => ({
      url: redactUrl(e.url),
      score: Number(e.health.score().toFixed(3)),
      latencyMs: e.health.latencyMs,
      successRate: Number(e.health.successRate.toFixed(3)),
      breaker: e.breaker.state,
      premium: e.premium,
    }));
  }
}

/**
 * Redact API keys from RPC URLs before they reach logs/metrics. Many providers
 * embed the key in the path (e.g. /v2/<KEY>) or as ?apikey=. Audit requirement:
 * "no sensitive data in logs".
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    // Redact query secrets.
    for (const k of u.searchParams.keys()) {
      if (/key|token|secret|api/i.test(k)) u.searchParams.set(k, '***');
    }
    // Redact a trailing path segment that looks like a key (long hex/base58).
    u.pathname = u.pathname.replace(/\/[A-Za-z0-9_-]{16,}(?=\/?$)/, '/***');
    return u.toString();
  } catch {
    return 'invalid-url';
  }
}
