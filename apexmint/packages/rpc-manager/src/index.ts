/**
 * @apexmint/rpc-manager — multi-RPC failover, health scoring, circuit breaking.
 *
 * Transport-injected: the package has no network code, so failover and breaker
 * behavior is fully deterministic under test. Real HTTP transports are supplied
 * by the chain adapters / app wiring.
 */

export * from './circuit-breaker.js';
export * from './health.js';
export * from './pool.js';
