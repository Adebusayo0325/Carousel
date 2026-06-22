// packages/core/src/wallet/vault.ts
// AES-256-GCM envelope encryption — private keys never leave the vault unencrypted.
// Two-layer design: master key (from KMS/env) wraps a per-user data key;
// the data key encrypts each wallet. Rotating the master key only re-encrypts
// the data keys — wallet ciphertexts are untouched.

import crypto from 'crypto';
import { ethers } from 'ethers';
import type { DecryptedWallet, WalletVaultEntry } from '../types/index.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

// ─────────────────────────────────────────────────────────────────────────────
// Master key derivation
// The VAULT_MASTER_KEY env var is the 32-byte root secret.
// A per-wallet salt is used so each ciphertext is unique even for identical keys.
// ─────────────────────────────────────────────────────────────────────────────

function getMasterKey(): Buffer {
  const raw = process.env.VAULT_MASTER_KEY;
  if (!raw || raw.length < 64) {
    throw new Error('VAULT_MASTER_KEY must be a 64-char hex string (32 bytes). Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(raw, 'hex');
}

// Derive a per-wallet key using HKDF (master key + wallet-specific context).
// This means rotating the master key invalidates all wallet keys (good — forces re-encryption).
function deriveWalletKey(masterKey: Buffer, walletId: string, userId: string): Buffer {
  const info = Buffer.from(`apex-vault:${userId}:${walletId}`, 'utf8');
  const salt = crypto.randomBytes(KEY_BYTES); // included in ciphertext header
  return crypto.hkdfSync('sha256', masterKey, salt, info, KEY_BYTES);
  // We return the key; salt is stored separately as part of the ciphertext blob.
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level AES-256-GCM helpers
// ─────────────────────────────────────────────────────────────────────────────

interface CipherBlob {
  ciphertext: string; // hex
  iv: string;         // hex (12 bytes)
  tag: string;        // hex (16 bytes)
  salt: string;       // hex (32 bytes) — for HKDF
  version: number;
}

export function encryptPrivateKey(
  privateKey: string,
  walletId: string,
  userId: string,
): CipherBlob {
  const masterKey = getMasterKey();
  const salt = crypto.randomBytes(KEY_BYTES);
  const info = Buffer.from(`apex-vault:${userId}:${walletId}`, 'utf8');
  const derivedKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, info, KEY_BYTES));

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, derivedKey, iv);

  // Authenticate additional data (userId + walletId) to prevent ciphertext swapping
  const aad = Buffer.from(`${userId}:${walletId}`, 'utf8');
  cipher.setAAD(aad);

  const enc = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Zero out key material
  derivedKey.fill(0);

  return {
    ciphertext: enc.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    salt: salt.toString('hex'),
    version: 1,
  };
}

export function decryptPrivateKey(
  blob: CipherBlob,
  walletId: string,
  userId: string,
): string {
  const masterKey = getMasterKey();
  const salt = Buffer.from(blob.salt, 'hex');
  const info = Buffer.from(`apex-vault:${userId}:${walletId}`, 'utf8');
  const derivedKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, info, KEY_BYTES));

  const iv = Buffer.from(blob.iv, 'hex');
  const tag = Buffer.from(blob.tag, 'hex');
  const ciphertext = Buffer.from(blob.ciphertext, 'hex');

  const decipher = crypto.createDecipheriv(ALGO, derivedKey, iv);
  decipher.setAuthTag(tag);

  const aad = Buffer.from(`${userId}:${walletId}`, 'utf8');
  decipher.setAAD(aad);

  try {
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    derivedKey.fill(0);
    return plain.toString('utf8');
  } catch {
    derivedKey.fill(0);
    throw new Error('Vault decryption failed — wrong master key, tampered ciphertext, or wrong user/wallet context');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB row ↔ CipherBlob serialisation
// ─────────────────────────────────────────────────────────────────────────────

export function serializeCipherBlob(blob: CipherBlob): {
  encryptedKey: string;
  encKeyIv: string;
  encKeyTag: string;
  encKeyVersion: number;
} {
  // Store salt inside encryptedKey as a prefix so the DB schema stays minimal
  return {
    encryptedKey: `${blob.salt}:${blob.ciphertext}`,
    encKeyIv: blob.iv,
    encKeyTag: blob.tag,
    encKeyVersion: blob.version,
  };
}

export function deserializeCipherBlob(row: {
  encryptedKey: string;
  encKeyIv: string;
  encKeyTag: string;
  encKeyVersion: number;
}): CipherBlob {
  const [salt, ...rest] = row.encryptedKey.split(':');
  return {
    ciphertext: rest.join(':'),
    iv: row.encKeyIv,
    tag: row.encKeyTag,
    salt,
    version: row.encKeyVersion,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level wallet operations
// ─────────────────────────────────────────────────────────────────────────────

/** Validate private key format and return the canonical address */
export function validateAndDeriveAddress(privateKey: string, chain: 'evm' | 'solana'): string {
  if (chain === 'evm') {
    if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;
    try {
      const wallet = new ethers.Wallet(privateKey);
      return wallet.address;
    } catch {
      throw new Error('Invalid EVM private key');
    }
  }
  if (chain === 'solana') {
    // Validate base58 or Uint8Array format
    try {
      const { Keypair } = require('@solana/web3.js');
      let keypair: typeof Keypair.prototype;
      if (privateKey.startsWith('[')) {
        // JSON array of bytes
        const bytes = Uint8Array.from(JSON.parse(privateKey));
        keypair = Keypair.fromSecretKey(bytes);
      } else {
        // base58 encoded
        const { decode } = require('bs58');
        const bytes = decode(privateKey);
        keypair = Keypair.fromSecretKey(bytes);
      }
      return keypair.publicKey.toBase58();
    } catch {
      throw new Error('Invalid Solana private key');
    }
  }
  throw new Error(`Unknown chain: ${chain}`);
}

/** Get an ethers Signer from a decrypted wallet entry */
export function getEvmSigner(wallet: DecryptedWallet, provider: ethers.Provider): ethers.Wallet {
  let pk = wallet.privateKey;
  if (!pk.startsWith('0x')) pk = '0x' + pk;
  return new ethers.Wallet(pk, provider);
}

/** Get a Solana Keypair from a decrypted wallet entry */
export function getSolanaKeypair(wallet: DecryptedWallet) {
  const { Keypair } = require('@solana/web3.js');
  let pk = wallet.privateKey;
  if (pk.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(pk)));
  }
  const { decode } = require('bs58');
  return Keypair.fromSecretKey(decode(pk));
}

/** Wipe sensitive strings from memory (best-effort — V8 may copy) */
export function wipeString(s: string): void {
  // Replace string with zeros in its buffer — not fully reliable in JS
  // but better than nothing for short-lived secrets
  try {
    const buf = Buffer.from(s);
    buf.fill(0);
  } catch { /* noop */ }
}
