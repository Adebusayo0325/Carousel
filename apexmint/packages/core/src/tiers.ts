/**
 * Tier & feature model — the single source of truth for entitlement gating.
 *
 * Audit requirement: "Feature gating must be server-side only ... impossible to
 * bypass." We achieve that by (a) defining features as a closed enum, (b)
 * deriving each tier's grant set from one authoritative matrix here, and (c)
 * enforcing via the pure `isFeatureAllowed` predicate that the API calls on
 * every protected route. The client is never trusted to assert its own tier.
 */

export const TIERS = ['basic', 'premium', 'enterprise'] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/** Closed set of gateable capabilities. */
export const FEATURES = [
  'evm-mint', // basic EVM minting
  'all-evm', // every registered EVM chain (vs. a basic-tier subset)
  'solana', // Solana / Metaplex minting
  'multi-wallet', // operate more than one wallet in parallel
  'scheduling', // time/phase scheduled mints
  'funding', // fund / withdraw flows
  'auto-list', // marketplace listing automation
  'auto-sell', // floor auto-sell / sweeping
  'bundles', // Flashbots (EVM) / Jito (Solana) bundles
  'priority-rpc', // priority RPC pool
  'simulation', // pre-flight fork simulation
  'risk-engine', // rug/honeypot/authority scoring
  'api-access', // programmatic API keys
  'white-label', // enterprise white-label
  'custom-rpc', // user-supplied RPC endpoints
] as const;
export type Feature = (typeof FEATURES)[number];

export function isFeature(value: unknown): value is Feature {
  return typeof value === 'string' && (FEATURES as readonly string[]).includes(value);
}

/**
 * Authoritative tier → feature grants. Higher tiers are supersets of lower ones
 * but we list explicitly rather than relying on inheritance so the grant set is
 * auditable at a glance.
 */
const TIER_MATRIX: Readonly<Record<Tier, readonly Feature[]>> = {
  basic: ['evm-mint', 'simulation', 'risk-engine'],
  premium: [
    'evm-mint',
    'all-evm',
    'solana',
    'multi-wallet',
    'scheduling',
    'funding',
    'auto-list',
    'auto-sell',
    'bundles',
    'priority-rpc',
    'simulation',
    'risk-engine',
    'api-access',
  ],
  enterprise: [...FEATURES],
};

/** Per-tier hard limits (defense-in-depth alongside feature flags). */
export interface TierLimits {
  readonly maxWallets: number;
  readonly maxActiveSchedules: number;
  readonly maxConcurrentMints: number;
  /** Sustained request budget for the API rate limiter. */
  readonly apiRequestsPerMinute: number;
}

const TIER_LIMITS: Readonly<Record<Tier, TierLimits>> = {
  basic: { maxWallets: 1, maxActiveSchedules: 1, maxConcurrentMints: 1, apiRequestsPerMinute: 60 },
  premium: { maxWallets: 25, maxActiveSchedules: 50, maxConcurrentMints: 10, apiRequestsPerMinute: 600 },
  enterprise: {
    maxWallets: 1000,
    maxActiveSchedules: 1000,
    maxConcurrentMints: 100,
    apiRequestsPerMinute: 6000,
  },
};

/** The features granted by a tier (defensive copy). */
export function featuresForTier(tier: Tier): Feature[] {
  return [...TIER_MATRIX[tier]];
}

export function limitsForTier(tier: Tier): TierLimits {
  return TIER_LIMITS[tier];
}

/**
 * The core gate. An action is allowed only if BOTH the tier grants the feature
 * AND (when an explicit per-key feature allow-list was issued) the key includes
 * it. Issued keys can narrow a tier's grants but never widen them.
 */
export function isFeatureAllowed(
  tier: Tier,
  feature: Feature,
  issuedFeatures?: readonly string[],
): boolean {
  if (!TIER_MATRIX[tier].includes(feature)) return false;
  if (issuedFeatures === undefined) return true;
  // An issued list of "all" is shorthand for "everything the tier grants".
  if (issuedFeatures.includes('all')) return true;
  return issuedFeatures.includes(feature);
}

/**
 * Resolve an issued feature spec (possibly containing the "all" shorthand or a
 * superset of tier grants) down to the concrete, tier-bounded grant set.
 */
export function resolveGrantedFeatures(
  tier: Tier,
  issuedFeatures?: readonly string[],
): Feature[] {
  return featuresForTier(tier).filter((f) => isFeatureAllowed(tier, f, issuedFeatures));
}
