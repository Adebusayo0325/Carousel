/**
 * Per-endpoint health scoring.
 *
 * Requirements: "RPC health scoring", "Chain latency monitoring",
 * "multi-RPC failover/load-balancing". We track an exponentially-weighted moving
 * average (EWMA) of latency and a smoothed success rate, then combine them into
 * a 0..1 health score the load balancer uses to weight endpoint selection.
 */

export interface HealthConfig {
  /** EWMA smoothing for latency (0..1, higher = more reactive). */
  readonly latencyAlpha: number;
  /** EWMA smoothing for success rate. */
  readonly successAlpha: number;
  /** Latency (ms) considered "1.0 bad" for normalization. */
  readonly latencyCeilingMs: number;
}

export function defaultHealthConfig(): HealthConfig {
  return { latencyAlpha: 0.3, successAlpha: 0.2, latencyCeilingMs: 2000 };
}

export class EndpointHealth {
  readonly url: string;
  #latencyEwma: number | null = null;
  #successRate = 1; // optimistic start
  #samples = 0;
  readonly #config: HealthConfig;

  constructor(url: string, config: HealthConfig = defaultHealthConfig()) {
    this.url = url;
    this.#config = config;
  }

  recordSuccess(latencyMs: number): void {
    this.#samples += 1;
    this.#latencyEwma =
      this.#latencyEwma === null
        ? latencyMs
        : this.#config.latencyAlpha * latencyMs + (1 - this.#config.latencyAlpha) * this.#latencyEwma;
    this.#successRate =
      this.#config.successAlpha * 1 + (1 - this.#config.successAlpha) * this.#successRate;
  }

  recordFailure(): void {
    this.#samples += 1;
    this.#successRate =
      this.#config.successAlpha * 0 + (1 - this.#config.successAlpha) * this.#successRate;
  }

  get latencyMs(): number | null {
    return this.#latencyEwma;
  }

  get successRate(): number {
    return this.#successRate;
  }

  get samples(): number {
    return this.#samples;
  }

  /**
   * Composite health in 0..1 (higher = healthier). Weighs success rate heavily
   * (a fast endpoint that returns wrong/failed answers is useless) and penalizes
   * latency up to the configured ceiling.
   */
  score(): number {
    const latencyComponent =
      this.#latencyEwma === null
        ? 0.7 // unknown latency: neutral-ish
        : 1 - Math.min(1, this.#latencyEwma / this.#config.latencyCeilingMs);
    return 0.7 * this.#successRate + 0.3 * latencyComponent;
  }
}
