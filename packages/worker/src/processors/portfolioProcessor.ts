// packages/worker/src/processors/portfolioProcessor.ts
import type { Job } from 'bullmq';
import { prisma } from '../../../api/src/plugins/db.js';

interface PortfolioSyncJobData {
  userId: string;
  walletAddresses: string[];
  chainIds: number[];
}

// Reservoir API base URLs per chain
const RESERVOIR_BASES: Record<number, string> = {
  1:       'https://api.reservoir.tools',
  8453:    'https://api-base.reservoir.tools',
  42161:   'https://api-arbitrum.reservoir.tools',
  10:      'https://api-optimism.reservoir.tools',
  137:     'https://api-polygon.reservoir.tools',
  56:      'https://api-bsc.reservoir.tools',
  7777777: 'https://api-zora.reservoir.tools',
  43114:   'https://api-avalanche.reservoir.tools',
};

interface ReservoirToken {
  token: {
    contract: string;
    tokenId: string;
    name?: string;
    description?: string;
    image?: string;
    collection?: { name?: string; slug?: string };
    kind?: string; // erc721 | erc1155
  };
  market?: {
    floorAsk?: { price?: { amount?: { native?: number } } };
  };
  ownership?: {
    tokenCount?: string;
    floorAskPrice?: { amount?: { native?: number } };
  };
}

async function fetchReservoirTokens(
  walletAddress: string,
  chainId: number,
  apiKey?: string,
): Promise<ReservoirToken[]> {
  const base = RESERVOIR_BASES[chainId];
  if (!base) return [];

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const tokens: ReservoirToken[] = [];
  let continuation: string | undefined;

  do {
    const url = new URL(`${base}/users/${walletAddress}/tokens/v10`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('includeTopBid', 'false');
    if (continuation) url.searchParams.set('continuation', continuation);

    try {
      const res = await fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) break;

      const data = await res.json() as { tokens?: ReservoirToken[]; continuation?: string };
      tokens.push(...(data.tokens ?? []));
      continuation = data.continuation;
    } catch {
      break;
    }
  } while (continuation && tokens.length < 1000);

  return tokens;
}

export async function processPortfolioSync(job: Job<PortfolioSyncJobData>): Promise<void> {
  const { userId, walletAddresses, chainIds } = job.data;
  const apiKey = process.env.RESERVOIR_API_KEY;

  // Get user's actual wallet addresses if not provided
  let addresses = walletAddresses;
  if (addresses.length === 0) {
    const wallets = await prisma.wallet.findMany({
      where: { userId, isActive: true, chain: 'evm' },
      select: { address: true },
    });
    addresses = wallets.map(w => w.address);
  }

  if (addresses.length === 0) return;

  let totalSynced = 0;
  const tasks: Promise<void>[] = [];

  for (const address of addresses) {
    for (const chainId of chainIds) {
      tasks.push(
        syncWalletChain(userId, address, chainId, apiKey).then(count => {
          totalSynced += count;
        }).catch(err => {
          console.warn(`[Portfolio] Sync failed for ${address} chain ${chainId}:`, (err as Error).message);
        }),
      );
    }
  }

  await Promise.allSettled(tasks);
  console.info(`[Portfolio] Synced ${totalSynced} NFTs for user ${userId.slice(0, 8)}`);
}

async function syncWalletChain(
  userId: string,
  walletAddress: string,
  chainId: number,
  apiKey?: string,
): Promise<number> {
  const tokens = await fetchReservoirTokens(walletAddress, chainId, apiKey);
  if (tokens.length === 0) return 0;

  // Upsert all tokens in a single transaction
  const ops = tokens.map(t => {
    const floorPrice = t.market?.floorAsk?.price?.amount?.native ?? null;
    return prisma.nftHolding.upsert({
      where: {
        userId_walletAddress_contractAddress_tokenId_chainId: {
          userId,
          walletAddress: walletAddress.toLowerCase(),
          contractAddress: t.token.contract.toLowerCase(),
          tokenId: t.token.tokenId,
          chainId,
        },
      },
      update: {
        name: t.token.name ?? null,
        imageUrl: t.token.image ?? null,
        collectionName: t.token.collection?.name ?? null,
        collectionSlug: t.token.collection?.slug ?? null,
        tokenStandard: t.token.kind?.toUpperCase() === 'ERC1155' ? 'ERC1155' : 'ERC721',
        floorPrice,
        lastSynced: new Date(),
      },
      create: {
        userId,
        walletAddress: walletAddress.toLowerCase(),
        contractAddress: t.token.contract.toLowerCase(),
        chainId,
        chain: 'evm',
        tokenId: t.token.tokenId,
        tokenStandard: t.token.kind?.toUpperCase() === 'ERC1155' ? 'ERC1155' : 'ERC721',
        name: t.token.name ?? null,
        imageUrl: t.token.image ?? null,
        collectionName: t.token.collection?.name ?? null,
        collectionSlug: t.token.collection?.slug ?? null,
        floorPrice,
      },
    });
  });

  await prisma.$transaction(ops);
  return tokens.length;
}
