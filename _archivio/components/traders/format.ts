// Shared types + pure formatters for the Top Traders dashboard.
// Consumes agent20 schema v2 (/api/leaderboard + /api/leaderboard/profile/[addr]).
//
// HONEST-ENGINE: every monetary field is `number | null` — null means the server
// redacted it for free/unauth (lib/paid-gating.ts). Render null via <Redacted>,
// NEVER as $0. Formatters here return '—' for null; the components use <Redacted>
// so null routes to the lock UI, not a fabricated number.

export interface ActorType {
  type:       'bot' | 'human';
  confidence: number;      // 0–100
  hft:        boolean;
  signals:    string[];
}

export interface OpsCounts {
  trades1h:    number | null;
  trades24h:   number | null;
  complete24h?: boolean;
}

// pnlUsdc/winRate/wilsonScore/volumeUsdc/wins/losses: null on free tier.
export interface LbEntry {
  wallet:          string;
  name:            string;
  pnlUsdc:         number | null;
  winRate:         number | null;
  wilsonScore:     number | null;
  lowSample?:      boolean;
  resolvedMarkets: number;
  volumeUsdc:      number | null;
  lastActive:      number;
  // Tenure floor: earliest resolved-market ts we've tracked (≤2-yr window). A LOWER
  // BOUND on first activity, not a guaranteed inception date. Absent on older scans → '—'.
  firstActive?:    number | null;
  wins:            number | null;
  losses:          number | null;
  twoSidedPct?:    number;
  // Per-window ranking stats, keyed 1d/7d/30d/all. Absent today (agent20 serves
  // all-time only); when backfilled, the window selector renders the extra options
  // automatically (see availWindows in TradersApp). null/absent → window hidden.
  windows?:        Partial<Record<WindowKey, WindowStat>> | null;
  walletType?:     'MM' | 'DIRECTIONAL' | null;
  actorType?:      ActorType | null;
  opsCounts?:      OpsCounts | null;
  hasProfile?:     boolean;
  verified?:       boolean;   // only rendered when the API actually sets it
}

export interface LbData {
  ok:               boolean;
  stale:            boolean;
  staleMinutes:     number | null;
  updatedAt:        string | null;
  windowDays:       number;
  marketsScanned:   number;
  totalWallets:     number;
  minMarketsToRank: number;
  categories:       Record<string, LbEntry[]>;
  bots?:            LbEntry[];   // bot/HFT wallets excluded from the directional board (Bots-HFT tab)
  disclaimer?:      string;
}

// windows values are null until the leaderboard agent backfills per-window data.
export type WindowKey = '1d' | '7d' | '30d' | 'all';
export interface WindowStat { pnlUsdc: number | null; volumeUsdc: number | null; rank: number | null; }

export interface ProfileCategory {
  category:        string;
  pnlUsdc:         number | null;
  winRate:         number | null;
  resolvedMarkets: number;
  volumeUsdc:      number | null;
}
export interface OpenPosition {
  marketTitle:   string | null;
  outcome:       string | null;
  size:          number | null;   // token count — not money, not redacted
  avgPrice:      number | null;
  currentValue:  number | null;
  unrealizedPnl: number | null;   // UNREALIZED, gross
  category?:     string | null;   // real Polymarket-tag/keyword category ('other' if unmatched)
  cid?:          string | null;   // real condition/market id
  side?:         string | null;   // held outcome/side
}
// One real fill inside the expandable closed-trade drawer. price/usd are null only
// when redacted for the free tier (never invented); secToExpiry is null when the
// market close couldn't be sourced → the drawer shows "expiry unavailable".
export interface ClosedFill {
  side:        string | null;   // BUY | SELL
  price:       number | null;   // 0..1 (dollars per share)
  size:        number;          // shares
  usd:         number | null;   // dollar notional (price × size)
  timestamp:   number;          // unix seconds
  secToExpiry: number | null;   // marketEndTs − fill ts
}
export interface ClosedTrade {
  marketTitle: string | null;
  outcome:     string | null;   // aggregate ledger doesn't pin the side → null
  entryPrice:  number | null;   // not reconstructed → null (never invented)
  exitPrice:   number | null;
  result:      'won' | 'lost' | 'resolved';
  realizedPnl: number | null;
  timestamp:   number;
  category?:   string | null;   // real category from the on-chain ledger ('other' if unmapped)
  cid?:        string | null;
  side?:       string | null;
  // Per-fill drawer breakdown (real; absent when no fills could be joined for this
  // row → the row stays non-expandable). marketEndTs is the real slug-derived close
  // (unix s); null → "expiry unavailable" (never a fabricated countdown).
  fills?:       ClosedFill[];
  marketEndTs?: number | null;
}
export interface ActivityItem {
  side:        string | null;   // BUY / SELL
  outcome:     string | null;
  price:       number | null;
  marketTitle: string | null;
  usdcSize:    number | null;
  timestamp:   number;
}
export interface TraderProfile {
  enrichedAt:    number;
  windows:       Record<WindowKey, WindowStat> | null;
  categories:    ProfileCategory[];
  positionsOpen: OpenPosition[];
  tradesClosed:  ClosedTrade[];
  activityRecent: ActivityItem[];
  actorType:     ActorType | null;
  opsCounts:     OpsCounts | null;
  // Entry→exit provenance: 'feed' = agent30's live per-fill feed; 'ondemand' =
  // reconstructed from a keyless Data-API read at request time (non-feed wallets);
  // 'feed+ondemand' = feed-sourced, with just-settled rows the feed hadn't yet
  // mirrored back-filled from a live Data-API read. On-demand cases are stamped with
  // entryExitAsOf (ms) so the UI can show "as of HH:MM:SS". Absent on older scans →
  // treated as feed/unstamped.
  entryExitSource?: 'feed' | 'ondemand' | 'feed+ondemand' | null;
  entryExitAsOf?:   number | null;
}

// ── Sample-robustness ─────────────────────────────────────────────────────────
// A wallet with too few resolved markets has a win rate that is noise, not skill
// ("100% on 1 trade" is luck). Ranking uses wilsonScore (agent20's Wilson 95%
// lower-bound, which already penalizes tiny samples); this flag is DISPLAY-ONLY
// (muted win% + "⚠ low sample (N)" badge) and never mutates a stored value.
// resolvedMarkets is a public/teaser field (not redacted), so this works on the
// free tier too. Threshold is intentionally conservative.
export const LOW_SAMPLE = 10; // resolvedMarkets < 10 → thin sample
export function isLowSample(resolvedMarkets: number | null | undefined): boolean {
  return (resolvedMarkets ?? 0) < LOW_SAMPLE;
}

// ── Formatters ──────────────────────────────────────────────────────────────

export function fmtPnl(n: number | null | undefined): string {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '−';
  const a = Math.abs(n);
  if (a >= 1_000_000) return sign + '$' + (a / 1_000_000).toFixed(2) + 'M';
  if (a >= 1_000)     return sign + '$' + (a / 1_000).toFixed(1) + 'k';
  return sign + '$' + a.toFixed(2);
}

export function fmtVol(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(0) + 'k';
  return '$' + n.toFixed(0);
}

export function fmtPrice(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toFixed(3);
}

export function fmtSize(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return n.toFixed(1);
}

export function fmtWallet(addr: string): string {
  if (!addr?.startsWith('0x')) return (addr ?? '').slice(0, 12);
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

export function fmtAge(ts: number | null | undefined): string {
  if (!ts) return '—';
  const secs = Date.now() / 1000 - ts;
  if (secs < 120)         return 'just now';
  if (secs < 3600)        return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400)       return Math.floor(secs / 3600) + 'h ago';
  if (secs < 86400 * 30)  return Math.floor(secs / 86400) + 'd ago';
  if (secs < 86400 * 365) return Math.floor(secs / 86400 / 30) + 'mo ago';
  return Math.floor(secs / 86400 / 365) + 'yr ago';
}

// Compact relative age including a weeks tier ("12m ago" / "3h ago" / "2d ago" /
// "3w ago" / "5mo ago" / "1y ago"). Used by the last-trade freshness chip.
export function fmtRelShort(ts: number | null | undefined): string {
  if (!ts) return '—';
  const secs = Date.now() / 1000 - ts;
  if (secs < 60)          return 'now';
  if (secs < 3600)        return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400)       return Math.floor(secs / 3600) + 'h ago';
  if (secs < 86400 * 7)   return Math.floor(secs / 86400) + 'd ago';
  if (secs < 86400 * 28)  return Math.floor(secs / 86400 / 7) + 'w ago';
  if (secs < 86400 * 365) return Math.floor(secs / 86400 / 30) + 'mo ago';
  return Math.floor(secs / 86400 / 365) + 'y ago';
}

// Tenure "since" — compact month-year of the earliest tracked trade (e.g. "Mar '24").
// firstActive is a lower bound (≤2-yr window), so it reads as "active since at least".
export function fmtSince(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  return `${mon} '${String(d.getUTCFullYear()).slice(-2)}`;
}

// "% gain" honest definition: NO capital-at-risk field exists, so this is profit ÷
// volume traded — a RETURN ON VOLUME, explicitly NOT an ROI on capital. null when
// either input is redacted/absent or volume is non-positive (never fabricated).
export function returnOnVolumePct(pnl: number | null | undefined, vol: number | null | undefined): number | null {
  if (pnl == null || vol == null || vol <= 0) return null;
  return (pnl / vol) * 100;
}
export function fmtPct1(n: number | null | undefined): string {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '−';
  return sign + Math.abs(n).toFixed(1) + '%';
}

// Last-trade freshness bucket → tone + label. green <24h · amber ≤7d · slate >7d.
export type Freshness = { tone: 'fresh' | 'week' | 'quiet'; dot: string; text: string };
export function freshness(ts: number | null | undefined): Freshness | null {
  if (!ts) return null;
  const secs = Date.now() / 1000 - ts;
  if (secs < 86400)     return { tone: 'fresh', dot: 'bg-mint-deep',  text: 'text-mint-deep' };
  if (secs < 86400 * 7) return { tone: 'week',  dot: 'bg-gold',       text: 'text-gold' };
  return { tone: 'quiet', dot: 'bg-muted', text: 'text-muted' };
}

export function fmtUpdated(updatedAt: string | null | undefined): string {
  if (!updatedAt) return '—';
  const secs = (Date.now() - new Date(updatedAt).getTime()) / 1000;
  if (secs < 60)    return `updated ${Math.max(0, Math.floor(secs))}s ago`;
  if (secs < 3600)  return `updated ${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `updated ${Math.floor(secs / 3600)}h ago`;
  return `updated ${Math.floor(secs / 86400)}d ago`;
}

export function displayName(e: { name?: string; wallet: string }): string {
  return e.name && !e.name.startsWith('0x') ? e.name : fmtWallet(e.wallet);
}

export function pnlColor(n: number | null | undefined): string {
  if (n == null) return 'text-muted';
  return n >= 0 ? 'text-mint-deep' : 'text-coral-ink';
}

export function wrColor(r: number | null | undefined): string {
  if (r == null) return 'text-muted';
  if (r >= 60) return 'text-mint-deep';
  if (r >= 50) return 'text-ink-2';
  return 'text-coral-ink/70';
}

// Category → bar/text accent. Unknown categories fall back to neutral (never crash).
export const CAT_BAR: Record<string, string> = {
  Crypto:        'bg-coral-ink/55',
  Sports:        'bg-violet/55',
  Politics:      'bg-gold/55',
  'Pop Culture': 'bg-mint/55',
  World:         'bg-mint-deep/55',
};
export const CAT_TEXT: Record<string, string> = {
  Crypto:        'text-coral-ink',
  Sports:        'text-violet',
  Politics:      'text-gold',
  'Pop Culture': 'text-mint-deep',
  World:         'text-mint-deep',
};
export function catBar(cat: string): string { return CAT_BAR[cat] ?? 'bg-muted/40'; }
export function catText(cat: string): string { return CAT_TEXT[cat] ?? 'text-muted'; }
