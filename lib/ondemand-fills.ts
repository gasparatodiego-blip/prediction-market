// lib/ondemand-fills.ts — on-demand per-wallet fill reconstruction.
//
// agent30's live feed tracks only a bounded set of wallets (~200-400). The
// leaderboard ranks thousands, so a detail page for a NON-feed wallet has no
// per-fill data and its closed-trade Entry→Exit column would show "— → —" on
// every row despite the data existing on-chain.
//
// This fetches that ONE wallet's real fills on demand from Polymarket's public,
// keyless Data API (data-api.polymarket.com/trades?user=<addr>) — the exact same
// source and record shape agent30 resyncs from — normalises them into a
// WalletRecord so the SAME enrichClosedTradesEntryExit() reconciliation path runs
// unchanged. Results are cached briefly per wallet (TTL) with an "as of" stamp so
// repeated views don't refetch; there is NO continuous polling — a fetch happens
// only when a non-feed wallet's profile is actually requested.
//
// HONEST-ENGINE: this only SOURCES real fills; it never invents a price. The
// downstream reconciliation guard decides which rows surface vs stay "—".
import { httpGet } from '@/lib/httpGet';
import type { RawFill, WalletRecord } from '@/lib/trader-analytics';

const DATA_API       = 'https://data-api.polymarket.com';
const FILLS_LIMIT    = 500;       // depth per on-demand read (Data API max page)
const REQ_TIMEOUT_MS = 12_000;    // wall-clock deadline (reuses lib/httpGet)
const CACHE_TTL_MS   = 60_000;    // 60s per-wallet cache — no continuous polling
const NEG_TTL_MS     = 30_000;    // cache failures/empties briefly too (avoid hammering)

interface CacheEntry { rec: WalletRecord | null; asOf: number }
const cache = new Map<string, CacheEntry>();

// Same normalisation agent30 applies to /trades records (normFill). One fill:
// tx + token + price/size/side. 999 is Polymarket's "no index" sentinel.
function normFill(t: Record<string, unknown> | null): RawFill | null {
  if (!t || t.asset == null || t.timestamp == null) return null;
  const price = Number(t.price), size = Number(t.size), ts = Number(t.timestamp);
  if (!Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(ts)) return null;
  const oi = t.outcomeIndex;
  return {
    txHash:       (t.transactionHash as string) || null,
    asset:        String(t.asset),
    conditionId:  (t.conditionId as string) || null,
    side:         (t.side as string) || null,          // BUY | SELL
    price, size, timestamp: ts,
    title:        (t.title as string) ?? null,
    slug:         (t.slug as string) ?? null,
    eventSlug:    (t.eventSlug as string) ?? null,
    outcome:      (t.outcome as string) ?? null,
    outcomeIndex: (oi != null && oi !== 999) ? Number(oi) : null,
  };
}

// Fetch + cache ONE wallet's fills as a WalletRecord. Returns { rec, asOf }.
// rec is null (with an "as of" stamp) when the Data API returns no fills or the
// fetch fails — the caller then honestly leaves every row "—".
export async function fetchWalletRecordOnDemand(
  address: string,
): Promise<{ rec: WalletRecord | null; asOf: number }> {
  const addr = (address || '').toLowerCase();
  const now  = Date.now();
  const hit  = cache.get(addr);
  if (hit) {
    const ttl = hit.rec ? CACHE_TTL_MS : NEG_TTL_MS;
    if (now - hit.asOf < ttl) return hit;
  }

  let rec: WalletRecord | null = null;
  try {
    const url = `${DATA_API}/trades?user=${addr}&limit=${FILLS_LIMIT}`;
    const r   = await httpGet(url, { timeoutMs: REQ_TIMEOUT_MS });
    const rows = Array.isArray(r.data) ? (r.data as Array<Record<string, unknown>>) : [];
    const fills = rows.map(normFill).filter((f): f is RawFill => f != null);
    if (fills.length > 0) {
      const times = fills.map(f => f.timestamp);
      rec = {
        fills,
        positions: [],                                   // not needed for entry→exit
        firstFillTs: Math.min(...times),
        lastFillTs:  Math.max(...times),
        fillsUpdatedAt: now,
        positionsUpdatedAt: null,
        fillsCount: fills.length,
        fillsCapped: rows.length >= FILLS_LIMIT,
      };
    }
  } catch {
    rec = null;                                          // network/timeout → honest "—"
  }

  const entry: CacheEntry = { rec, asOf: now };
  cache.set(addr, entry);
  return entry;
}
