/**
 * @apexmint/core — shared vocabulary for the whole platform.
 *
 * Contains zero I/O and zero chain-specific code. Everything here is pure and
 * unit-testable, which is why the higher-risk packages depend on it.
 */

export * from './result.js';
export * from './errors.js';
export * from './tiers.js';
export * from './chain.js';
export * from './registry.js';
export * from './validation.js';
