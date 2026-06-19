/**
 * Circuit breaker.
 *
 * Requirement: "Circuit breakers". Prevents hammering a dead RPC endpoint: after
 * N consecutive failures the breaker OPENS and short-circuits calls for a
 * cooldown; then it goes HALF-OPEN and lets a single probe through; success
 * CLOSES it, failure re-OPENS with backoff.
 *
 * Time is injected via `now()` so state transitions are deterministic in tests.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerConfig {
  /** Consecutive failures before opening. */
  readonly failureThreshold: number;
  /** Base cooldown (ms) before transitioning open -> half-open. */
  readonly cooldownMs: number;
  /** Max cooldown after repeated re-opens (exponential backoff cap). */
  readonly maxCooldownMs: number;
}

export function defaultBreakerConfig(): BreakerConfig {
  return { failureThreshold: 3, cooldownMs: 1000, maxCooldownMs: 30_000 };
}

export class CircuitBreaker {
  #state: BreakerState = 'closed';
  #consecutiveFailures = 0;
  #openedAt = 0;
  #openCount = 0;
  readonly #config: BreakerConfig;
  readonly #now: () => number;

  constructor(config: BreakerConfig = defaultBreakerConfig(), now: () => number = Date.now) {
    this.#config = config;
    this.#now = now;
  }

  get state(): BreakerState {
    return this.#stateAt(this.#now());
  }

  /** Whether a call may proceed right now. */
  canRequest(): boolean {
    return this.#stateAt(this.#now()) !== 'open';
  }

  private currentCooldown(): number {
    // Exponential backoff on repeated opens, capped.
    const factor = Math.pow(2, Math.max(0, this.#openCount - 1));
    return Math.min(this.#config.maxCooldownMs, this.#config.cooldownMs * factor);
  }

  #stateAt(t: number): BreakerState {
    if (this.#state === 'open') {
      if (t - this.#openedAt >= this.currentCooldown()) {
        return 'half-open';
      }
      return 'open';
    }
    return this.#state;
  }

  recordSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#state = 'closed';
    this.#openCount = 0;
  }

  recordFailure(): void {
    const t = this.#now();
    const effective = this.#stateAt(t);
    if (effective === 'half-open') {
      // Probe failed — re-open with longer backoff.
      this.#openState(t);
      return;
    }
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= this.#config.failureThreshold) {
      this.#openState(t);
    }
  }

  #openState(t: number): void {
    this.#state = 'open';
    this.#openedAt = t;
    this.#openCount += 1;
    this.#consecutiveFailures = 0;
  }

  /** For metrics/inspection. */
  snapshot(): { state: BreakerState; openCount: number; cooldownMs: number } {
    return { state: this.state, openCount: this.#openCount, cooldownMs: this.currentCooldown() };
  }
}
