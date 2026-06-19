/**
 * @apexmint/risk-engine — explainable rug/honeypot risk scoring (0–100).
 *
 * Pure scoring over normalized RiskFacts. The chain/contract-intel layers gather
 * the facts; this package turns them into an auditable score + per-signal
 * breakdown that the mint engine uses as a pre-flight gate.
 */

export * from './facts.js';
export * from './score.js';
