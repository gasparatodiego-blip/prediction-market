// Types for lib/maker/market-catalog.js — venue metadata for markets the operator added by hand.
//
// It is a FALLBACK source for lib/maker/manual-order.resolveMarketRules, never an override: a market on
// the live reward board keeps using the board. Being in this catalog grants no permission to place — the
// allowlist, manual mode, the caps, the kill switch and validateOrder() all still apply.

export interface MarketCatalogDeps {
  catalogFile?: string;
  catalogAuditFile?: string;
  now?: () => number;
  fs?: unknown;
  readFileSync?: unknown;
  writeFileSync?: unknown;
  renameSync?: unknown;
  mkdirSync?: unknown;
}

export interface CatalogRecord {
  marketId: string;
  question: string | null;
  slug: string | null;
  category: string | null;
  tokenIdYes: string;
  tokenIdNo: string;
  tick: number;
  negRisk: boolean;
  /** null ⇒ the venue publishes no reward programme for this market. */
  rewardsDailyRate: number | null;
  rewardsMaxSpreadCents: number | null;
  rewardsMinSize: number | null;
  hasRewards: boolean;
  endDate: string | null;
  /** Book AT FETCH TIME — a snapshot. Readers report its age (fetchedAt), never present it as live. */
  mid: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spreadCents: number | null;
  fetchedAt: number;
  addedAt: number;
  updatedAt: number;
  by: string | null;
  reason: string | null;
}

export interface MarketCatalogState {
  readable: boolean;
  error: string | null;
  markets: Record<string, CatalogRecord>;
  count: number;
  catalogFile: string;
}

export function readMarketCatalog(deps?: MarketCatalogDeps): MarketCatalogState;
export function readMarketRecord(marketId: string | null | undefined, deps?: MarketCatalogDeps): CatalogRecord | null;
/**
 * The INPUT is deliberately nullable everywhere the venue can answer "unknown": upsertMarket is the
 * validator, not the caller. It refuses (with `missing`) when a field the placement path needs is absent,
 * so a caller must be able to hand it exactly what it read — nulls included — rather than pre-filtering
 * and deciding on its own what counts as complete.
 */
export interface CatalogInput {
  marketId?: string | null;
  conditionId?: string | null;
  question?: string | null;
  slug?: string | null;
  category?: string | null;
  tokenIdYes?: string | null;
  tokenIdNo?: string | null;
  tick?: number | null;
  negRisk?: boolean | null;
  rewardsDailyRate?: number | null;
  rewardsMaxSpreadCents?: number | null;
  rewardsMinSize?: number | null;
  endDate?: string | null;
  mid?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  spreadCents?: number | null;
  fetchedAt?: number | null;
}

export function upsertMarket(
  market: CatalogInput,
  who?: { by?: string | null; reason?: string | null },
  deps?: MarketCatalogDeps,
): { ok: boolean; error?: string; marketId: string | null; record?: CatalogRecord; missing?: string[]; existed?: boolean };
export function removeMarket(
  marketId: string,
  who?: { by?: string | null; reason?: string | null },
  deps?: MarketCatalogDeps,
): { ok: boolean; error?: string; marketId: string | null; existed?: boolean };
export function missingFields(m: unknown): string[];

export const CATALOG_FILE: string;
export const AUDIT_FILE: string;
export const REQUIRED_FIELDS: readonly string[];
