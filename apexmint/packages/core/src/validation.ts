/**
 * Minimal, dependency-free input validation.
 *
 * Audit requirement: "input sanitization". We keep a tiny set of strict,
 * well-tested validators rather than trusting incoming strings. Address
 * validators are intentionally format-only (checksum/curve checks belong to the
 * chain adapters that have the crypto libs).
 */

import { Errors, type AppError } from './errors.js';
import { err, ok, type Result } from './result.js';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Base58, 32–44 chars, excluding the ambiguous 0/O/I/l.
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NON_NEGATIVE_INT = /^[0-9]+$/;

export function validateEvmAddress(value: string): Result<string, AppError> {
  if (!EVM_ADDRESS.test(value)) {
    return err(Errors.validation('BAD_EVM_ADDRESS', 'Malformed EVM address'));
  }
  return ok(value.toLowerCase());
}

export function validateSolanaAddress(value: string): Result<string, AppError> {
  if (!SOLANA_ADDRESS.test(value)) {
    return err(Errors.validation('BAD_SOLANA_ADDRESS', 'Malformed Solana address'));
  }
  return ok(value);
}

/** A non-negative integer expressed as a decimal string (wei/lamports). */
export function validateRawAmount(value: string): Result<string, AppError> {
  if (!NON_NEGATIVE_INT.test(value)) {
    return err(Errors.validation('BAD_AMOUNT', 'Amount must be a non-negative integer string'));
  }
  // Normalize leading zeros while preserving "0".
  const normalized = value.replace(/^0+(?=\d)/, '');
  return ok(normalized);
}

export function validateQuantity(value: number, max = 10_000): Result<number, AppError> {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    return err(
      Errors.validation('BAD_QUANTITY', `Quantity must be an integer in 1..${max}`, { value, max }),
    );
  }
  return ok(value);
}

/** Strip ASCII C0 controls (0x00–0x1F) and DEL (0x7F) from a string. */
function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/** Reject control chars / overlong labels before persisting user text. */
export function sanitizeLabel(value: string, maxLen = 64): Result<string, AppError> {
  const stripped = stripControlChars(value).trim();
  if (stripped.length === 0) {
    return err(Errors.validation('EMPTY_LABEL', 'Label cannot be empty'));
  }
  if (stripped.length > maxLen) {
    return err(Errors.validation('LABEL_TOO_LONG', `Label exceeds ${maxLen} chars`));
  }
  return ok(stripped);
}
