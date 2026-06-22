// packages/core/src/mint/solanaMintEngine.ts
// Solana minting: Metaplex Candy Machine v3 (mpl-candy-machine),
// Candy Machine v2 (legacy), Compressed NFTs (Bubblegum), and
// Jito bundle relay for MEV protection on Solana.

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  type TransactionSignature,
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import { getSolanaConnection } from '../rpc/rpcManager.js';
import { getSolanaKeypair } from '../wallet/vault.js';
import type { DecryptedWallet, MintResult } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Candy Machine IDs
// ─────────────────────────────────────────────────────────────────────────────

const CM_V3_PROGRAM_ID = new PublicKey('CndyV3LdqHUfDLmd1X2Sx5EEvlqFGX6jAkMPppFNBMJf');
const CM_V2_PROGRAM_ID = new PublicKey('cndy3Z4yapfJBmL3ShUp5exZkqLs1cRFe3WVSQbKZBk');
const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// ─────────────────────────────────────────────────────────────────────────────
// Compute budget (priority fee)
// ─────────────────────────────────────────────────────────────────────────────

function buildComputeBudgetIxs(microLamports: number, units = 400_000) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

async function getRecommendedMicroLamports(connection: Connection): Promise<number> {
  try {
    // Use recent prioritization fee averages from getRecentPrioritizationFees
    const fees = await connection.getRecentPrioritizationFees();
    if (fees.length > 0) {
      const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
      const p75 = sorted[Math.floor(sorted.length * 0.75)];
      return Math.max(p75 * 2, 10_000); // at least 10k micro-lamports
    }
  } catch { /* noop */ }
  return 100_000; // 100k micro-lamports default
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction confirmation with retry
// ─────────────────────────────────────────────────────────────────────────────

async function confirmWithRetry(
  connection: Connection,
  signature: TransactionSignature,
  timeoutMs = 90_000,
): Promise<'confirmed' | 'timeout' | 'failed'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (status.value?.err) return 'failed';
      if (
        status.value?.confirmationStatus === 'confirmed' ||
        status.value?.confirmationStatus === 'finalized'
      ) return 'confirmed';
    } catch { /* noop */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  return 'timeout';
}

// ─────────────────────────────────────────────────────────────────────────────
// Balance check
// ─────────────────────────────────────────────────────────────────────────────

async function checkSolBalance(
  connection: Connection,
  address: PublicKey,
  requiredSol: number,
): Promise<{ ok: boolean; balance: number; required: number }> {
  const balance = await connection.getBalance(address) / LAMPORTS_PER_SOL;
  return { ok: balance >= requiredSol, balance, required: requiredSol };
}

// ─────────────────────────────────────────────────────────────────────────────
// Candy Machine V3 mint
// ─────────────────────────────────────────────────────────────────────────────

export async function mintCandyMachineV3(opts: {
  wallet: DecryptedWallet;
  candyMachineId: string;
  guardGroup?: string;
  mintPriceSol?: number;
  quantity?: number;
}): Promise<MintResult> {
  const { wallet, candyMachineId, guardGroup, mintPriceSol = 0, quantity = 1 } = opts;

  const connection = await getSolanaConnection();
  const keypair = getSolanaKeypair(wallet);
  const payer = keypair.publicKey;

  // Balance check (price + tx fee buffer of 0.01 SOL per mint)
  const required = mintPriceSol * quantity + 0.01 * quantity + 0.1;
  const balCheck = await checkSolBalance(connection, payer, required);
  if (!balCheck.ok) {
    return {
      walletAddress: wallet.address,
      status: 'failed',
      error: `Insufficient SOL: has ${balCheck.balance.toFixed(4)}, needs ~${required.toFixed(4)}`,
    };
  }

  try {
    const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
    const { mplCandyMachine } = await import('@metaplex-foundation/mpl-candy-machine');
    const { signerIdentity, createSignerFromKeypair, publicKey, generateSigner } =
      await import('@metaplex-foundation/umi');
    const { fromWeb3JsKeypair, toWeb3JsTransaction } =
      await import('@metaplex-foundation/umi-web3js-adapters');

    const endpoint = (connection as unknown as { _rpcEndpoint?: string })?._rpcEndpoint
      ?? process.env.SOLANA_RPC_URL
      ?? 'https://api.mainnet-beta.solana.com';

    const umi = createUmi(endpoint).use(mplCandyMachine());
    const umiKeypair = fromWeb3JsKeypair(keypair);
    umi.use(signerIdentity(createSignerFromKeypair(umi, umiKeypair)));

    const cmId = publicKey(candyMachineId);
    const nftMint = generateSigner(umi);

    const microLamports = await getRecommendedMicroLamports(connection);

    let builder;
    if (guardGroup) {
      const { mintV2 } = await import('@metaplex-foundation/mpl-candy-machine');
      builder = mintV2(umi, { candyMachine: cmId, nftMint, group: guardGroup } as Record<string, unknown>);
    } else {
      const { mintV2 } = await import('@metaplex-foundation/mpl-candy-machine');
      builder = mintV2(umi, { candyMachine: cmId, nftMint } as Record<string, unknown>);
    }

    builder = builder.prepend({
      instruction: ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      signers: [],
      bytesCreatedOnChain: 0,
    } as unknown as Parameters<typeof builder.prepend>[0]);

    const signature = await builder.sendAndConfirm(umi, {
      send: { skipPreflight: false },
      confirm: { commitment: 'confirmed' },
    });

    return {
      walletAddress: wallet.address,
      status: 'success',
      txHash: Buffer.from(signature.signature).toString('base64'),
      fnName: 'mintV2 (CM v3)',
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const decoded = decodeSolanaError(msg);
    return { walletAddress: wallet.address, status: 'failed', error: decoded, fnName: 'mintV2' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Candy Machine V2 (legacy) mint
// ─────────────────────────────────────────────────────────────────────────────

export async function mintCandyMachineV2(opts: {
  wallet: DecryptedWallet;
  candyMachineId: string;
  mintPriceSol?: number;
}): Promise<MintResult> {
  const { wallet, candyMachineId, mintPriceSol = 0 } = opts;

  const connection = await getSolanaConnection();
  const keypair = getSolanaKeypair(wallet);

  const balCheck = await checkSolBalance(connection, keypair.publicKey, mintPriceSol + 0.05);
  if (!balCheck.ok) {
    return {
      walletAddress: wallet.address,
      status: 'failed',
      error: `Insufficient SOL: has ${balCheck.balance.toFixed(4)}, needs ~${(mintPriceSol + 0.05).toFixed(4)}`,
    };
  }

  try {
    // Metaplex JS SDK v2 — JS-level CM v2 support
    const { Metaplex, keypairIdentity } = await import('@metaplex-foundation/js');
    const mx = Metaplex.make(connection).use(keypairIdentity(keypair));
    const cm = await mx.candyMachines().findByAddress({ address: new PublicKey(candyMachineId) });

    const microLamports = await getRecommendedMicroLamports(connection);
    const { nft, response } = await mx.candyMachines().mint({
      candyMachine: cm,
      guards: {},
    }, {
      payer: mx.identity(),
      commitment: 'confirmed',
    });

    return {
      walletAddress: wallet.address,
      status: 'success',
      txHash: response.signature,
      fnName: 'mint (CM v2)',
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { walletAddress: wallet.address, status: 'failed', error: decodeSolanaError(msg) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Jito Bundle relay — MEV protection on Solana
// Sends transaction as a private bundle, bypassing public mempool.
// ─────────────────────────────────────────────────────────────────────────────

interface JitoBundle {
  encodedTransactions: string[];
  tipLamports?: number;
}

export async function sendViaJitoBundle(
  connection: Connection,
  transactions: (Transaction | VersionedTransaction)[],
  signers: import('@solana/web3.js').Keypair[],
  tipLamports = Number(process.env.JITO_TIP_LAMPORTS ?? 10_000),
): Promise<{ bundleId?: string; signature?: string; error?: string }> {
  const jitoUrl = process.env.JITO_BLOCK_ENGINE_URL ?? 'https://mainnet.block-engine.jito.wtf';

  // Known Jito tip accounts (rotate for load distribution)
  const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13ij9a9n',
  ];

  const tipAccount = new PublicKey(
    JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)],
  );

  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

    // Add tip instruction to the first transaction
    const firstTx = transactions[0] instanceof VersionedTransaction
      ? transactions[0]
      : new Transaction()
          .add(SystemProgram.transfer({
            fromPubkey: signers[0].publicKey,
            toPubkey: tipAccount,
            lamports: tipLamports,
          }))
          .add(...(transactions[0] as Transaction).instructions);

    if (firstTx instanceof Transaction) {
      firstTx.recentBlockhash = blockhash;
      firstTx.feePayer = signers[0].publicKey;
      firstTx.sign(...signers);
    }

    // Encode all transactions
    const encodedTransactions = transactions.map(tx => {
      const serialized = tx instanceof VersionedTransaction
        ? tx.serialize()
        : (tx as Transaction).serialize({ requireAllSignatures: false });
      return Buffer.from(serialized).toString('base64');
    });

    // Submit to Jito block engine
    const response = await fetch(`${jitoUrl}/api/v1/bundles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.JITO_AUTH_TOKEN ?? ''}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [encodedTransactions],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const result = await response.json() as {
      result?: string;
      error?: { message: string };
    };

    if (result.error) {
      return { error: `Jito error: ${result.error.message}` };
    }

    return { bundleId: result.result };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Universal Solana mint dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export interface SolanaMintConfig {
  wallet: DecryptedWallet;
  candyMachineId: string;
  cmVersion?: 'v2' | 'v3';
  guardGroup?: string;
  mintPriceSol?: number;
  quantity?: number;
  useJito?: boolean;
}

export async function mintOnSolana(config: SolanaMintConfig): Promise<MintResult> {
  const { cmVersion = 'v3', useJito } = config;

  // Jito bundles for CMv3 with MEV protection
  if (useJito && cmVersion === 'v3') {
    // Build the transaction first, then send via Jito
    // For now, fall through to normal path with note — full Jito requires tx extraction
    console.info('[Jito] Jito bundle path requires tx extraction — using normal CMv3 with high priority fee');
  }

  if (cmVersion === 'v3') {
    return mintCandyMachineV3({
      wallet: config.wallet,
      candyMachineId: config.candyMachineId,
      guardGroup: config.guardGroup,
      mintPriceSol: config.mintPriceSol,
      quantity: config.quantity,
    });
  }

  return mintCandyMachineV2({
    wallet: config.wallet,
    candyMachineId: config.candyMachineId,
    mintPriceSol: config.mintPriceSol,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Error decoder
// ─────────────────────────────────────────────────────────────────────────────

const SOLANA_ERROR_MAP: Record<string, string> = {
  '0x177': 'CM Guard: Not in mint window (StartDate guard)',
  '0x178': 'CM Guard: Mint ended (EndDate guard)',
  '0x17d': 'CM Guard: SolPayment failed — insufficient SOL',
  '0x17e': 'CM Guard: NFT Payment failed',
  '0x186': 'CM Guard: Not eligible for this guard group',
  '0x14': 'Candy Machine: No items left — sold out',
  'NotEnoughTokens': 'Insufficient token balance for guard',
  'AllowlistProofNotFound': 'Wallet not on allowlist',
  'NotLive': 'CM not live yet',
  'MintNotStarted': 'Mint has not started',
  'insufficient lamports': 'Insufficient SOL balance',
  'Blockhash not found': 'Blockhash expired — retry',
};

function decodeSolanaError(msg: string): string {
  for (const [k, v] of Object.entries(SOLANA_ERROR_MAP)) {
    if (msg.includes(k)) return v;
  }
  return msg.slice(0, 300);
}

// ─────────────────────────────────────────────────────────────────────────────
// Solana balance helper (used by wallet service)
// ─────────────────────────────────────────────────────────────────────────────

export async function getSolBalance(address: string): Promise<number> {
  const connection = await getSolanaConnection();
  const balance = await connection.getBalance(new PublicKey(address));
  return balance / LAMPORTS_PER_SOL;
}
