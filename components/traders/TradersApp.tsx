'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link           from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Activity }   from 'lucide-react';
import Eyebrow        from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import PlatformLogo   from '@/components/PlatformLogo';
import { Redacted }   from '@/app/components/ui/Redacted';
import { PlatformLink } from '@/app/components/ui/PlatformLink';
import { polymarketProfileUrl } from '@/lib/platform-links';
import { ActorBadge, VerifiedTick, WinRateBar, WinRateLabel, FreshnessChip, LowSampleBadge, CategoryTag, ConfidenceBar, CopyButton } from './parts';
import TraderProfileView from './TraderProfile';
import CopyConfigPanel from './CopyConfigPanel';
import MarketsTab from './MarketsTab';
import {
  fmtPnl, fmtVol, fmtWallet, fmtUpdated, fmtSince, fmtPct1, returnOnVolumePct,
  displayName, pnlColor, catText, isLowSample,
  type LbData, type LbEntry, type TraderProfile, type WindowKey,
} from './format';

type Tab = 'leaderboard' | 'bots' | 'markets';
type RankBy = 'profit' | 'volume' | 'return' | 'win' | 'wilson' | 'recent';

const RANK_LABEL: Record<RankBy, string> = { profit: 'profit', volume: 'volume', return: 'return %', win: 'win rate', wilson: 'consistency', recent: 'recent' };
// Sort chips, in display order. Every key ranks on a REAL list-level field (see
// rankMetric) — no fabricated sort. Tooltips flag the honest caveats.
const RANK_ORDER: RankBy[] = ['profit', 'return', 'win', 'wilson', 'volume', 'recent'];
const RANK_TITLE: Partial<Record<RankBy, string>> = {
  return: 'return on volume = profit ÷ volume traded (not an ROI on capital)',
  win:    'raw win rate — % of resolved markets won (thin-sample wallets are floored below proven ones)',
  wilson: 'consistency = Wilson 95% lower bound of win rate — sample-robust, the board default tiebreak',
  recent: 'most recently active first (last on-chain trade) — a public field, works on every tier',
};

// The metric a given rank-by key ranks on, for a single entry. Reuses the EXACT
// field shown on the card: return === returnOnVolumePct(pnl, vol) (the "+X% on vol"
// figure). Returns null when the value is unavailable (e.g. vol ≤ 0) so the caller
// floors it last — never a fabricated number. Profit/volume math is untouched.
function rankMetric(e: LbEntry, rankBy: RankBy): number | null {
  if (rankBy === 'return') return returnOnVolumePct(e.pnlUsdc, e.volumeUsdc);
  if (rankBy === 'win')    return e.winRate;      // raw win % — null (gated) on free tier
  if (rankBy === 'wilson') return e.wilsonScore;  // Wilson 95% lower bound — null (gated) on free tier
  if (rankBy === 'recent') return e.lastActive;   // last-trade ts — public, sorts on every tier
  return rankBy === 'volume' ? e.volumeUsdc : e.pnlUsdc;
}

// Shared ranking (honest-engine): thin-sample wallets floored below proven ones;
// then sort by the chosen metric when any entry has it, else keep source order
// (never fabricate an order); wilsonScore DESC tiebreak. null metric → sorts last.
function sortByRank(list: LbEntry[], rankBy: RankBy): LbEntry[] {
  const hasValues = list.some(e => rankMetric(e, rankBy) != null);
  return list.sort((a, b) => {
    const aLow = isLowSample(a.resolvedMarkets), bLow = isLowSample(b.resolvedMarkets);
    if (aLow !== bLow) return aLow ? 1 : -1;
    if (hasValues) {
      const d = (rankMetric(b, rankBy) ?? -Infinity) - (rankMetric(a, rankBy) ?? -Infinity);
      if (d !== 0) return d;
    }
    return (b.wilsonScore ?? -Infinity) - (a.wilsonScore ?? -Infinity);
  });
}

// Minimum return-on-volume filter. Off at 0 (show everything, including entries
// whose return is unavailable). Above 0, only entries with a real return ≥ min
// survive — null/0-volume entries are hidden (they have no qualifying return),
// never counted as passing.
function filterByMinReturn(list: LbEntry[], minReturn: number): LbEntry[] {
  if (minReturn <= 0) return list;
  return list.filter(e => {
    const r = returnOnVolumePct(e.pnlUsdc, e.volumeUsdc);
    return r != null && r >= minReturn;
  });
}

// Human-only filter (heuristic — actorType is an inference, never a Polymarket
// label). Keeps entries NOT flagged 'bot'; an entry with no actorType is unknown,
// not a bot, so it stays. actorType is public → works on every tier.
function filterByHuman(list: LbEntry[], on: boolean): LbEntry[] {
  if (!on) return list;
  return list.filter(e => e.actorType?.type !== 'bot');
}

// Minimum resolved-markets filter — hides thin-sample wallets below the threshold.
// resolvedMarkets is a public count (not gated), so this works on every tier.
function filterByMinResolved(list: LbEntry[], min: number): LbEntry[] {
  if (min <= 0) return list;
  return list.filter(e => (e.resolvedMarkets ?? 0) >= min);
}

// ── Combined performance + activity filter (AND logic, honest-engine) ──────────
// Each constraint is a [min,max] range or a boolean. A trader is EXCLUDED by a range
// only when that range is ACTIVELY constraining (min>floor or max<ceil) AND its field
// is null/"—" for that trader — never silently dropped when the filter is off. No
// fabricated stats: only REAL agent20 list fields (winRate, wilsonScore, volumeUsdc,
// returnOnVolume, lastActive, verified). Sharpe / max-drawdown / avg-hold are NOT
// list-level fields (profile-only) and are deliberately absent here rather than faked.
interface CombinedFilters {
  winMin: number; winMax: number;          // win rate %   [0,100]
  wilMin: number; wilMax: number;          // Wilson score [0,1]
  roiMin: number; roiMax: number;          // return-on-volume % [-100,100]
  volMin: number; volMax: number;          // volume $ [0,∞] (volMax=0 means no upper bound)
  verifiedOnly: boolean;
  active24h: boolean;
}
const FILTERS_OFF: CombinedFilters = {
  winMin: 0, winMax: 100, wilMin: 0, wilMax: 1, roiMin: -100, roiMax: 100,
  volMin: 0, volMax: 0, verifiedOnly: false, active24h: false,
};
function filtersActive(f: CombinedFilters): boolean {
  return f.winMin > 0 || f.winMax < 100 || f.wilMin > 0 || f.wilMax < 1
    || f.roiMin > -100 || f.roiMax < 100 || f.volMin > 0 || f.volMax > 0
    || f.verifiedOnly || f.active24h;
}
// A range excludes a trader iff the range is active AND (value is null OR out of range).
function rangeReject(value: number | null | undefined, min: number, max: number, floor: number, ceil: number): boolean {
  const active = min > floor || max < ceil;
  if (!active) return false;                 // filter off → never excludes, never "—"-drops
  if (value == null) return true;            // actively constrained + unmeasurable → excluded ("—")
  return value < min || value > max;
}
function filterCombined(list: LbEntry[], f: CombinedFilters): LbEntry[] {
  if (!filtersActive(f)) return list;
  const dayAgo = Math.floor(Date.now() / 1000) - 86_400;
  return list.filter(e => {
    if (rangeReject(e.winRate, f.winMin, f.winMax, 0, 100)) return false;
    if (rangeReject(e.wilsonScore, f.wilMin, f.wilMax, 0, 1)) return false;
    if (rangeReject(returnOnVolumePct(e.pnlUsdc, e.volumeUsdc), f.roiMin, f.roiMax, -100, 100)) return false;
    // volume: volMax=0 → no upper bound; treat ceil as +∞ so only the min side constrains.
    if (rangeReject(e.volumeUsdc, f.volMin, f.volMax > 0 ? f.volMax : Number.POSITIVE_INFINITY, 0, Number.POSITIVE_INFINITY)) return false;
    if (f.verifiedOnly && !(e as any).verified) return false;
    if (f.active24h && !((e.lastActive ?? 0) >= dayAgo)) return false;
    return true;
  });
}

const WINDOW_LABEL: Record<WindowKey, string> = { '1d': '1D', '7d': '7D', '30d': '30D', all: 'ALL' };

interface CopyConfigLite { walletAddr: string }

// ── Server-backed copy state ──────────────────────────────────────────────────
// Slots + which wallets are being copied are now authoritative on the server
// (Prisma CopyConfig, /api/copy/config). No localStorage: a config is real only
// once it's persisted server-side (with server-enforced slot limits). Unauth →
// 401 → empty/free view (no login wall on the page itself).
function useServerCopy() {
  const [configs, setConfigs] = useState<CopyConfigLite[]>([]);
  const [slots, setSlots]     = useState<{ used: number; limit: number }>({ used: 0, limit: 1 });

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/copy/config');
      if (r.status === 401) { setConfigs([]); return; }   // keep default free slots
      const d = await r.json();
      setConfigs(d.configs ?? []);
      if (d.slots) setSlots(d.slots);
    } catch { /* leave prior state */ }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const isCopying = useCallback(
    (w: string) => configs.some(c => c.walletAddr.toLowerCase() === w.toLowerCase()),
    [configs]);

  return { configs, slots, reload, isCopying, count: slots.used };
}

export default function TradersApp() {
  const router                = useRouter();
  const pathname              = usePathname();
  const searchParams          = useSearchParams();

  // Origin section (tab / category / rank / return-filter) lives in the URL so the
  // phone/browser BACK button from a /dashboard/traders/<address> detail page returns
  // to the EXACT section the user came from — not the default "All traders" board.
  // State is seeded from the query params on mount and mirrored back on change
  // (router.replace, no new history entry) so back pops straight to the prior filters.
  const [tab, setTab]         = useState<Tab>(() => {
    const t = searchParams.get('tab');
    return t === 'bots' || t === 'markets' ? t : 'leaderboard';
  });
  const [cat, setCat]         = useState(() => searchParams.get('cat') || 'All');
  const [rankBy, setRankBy]   = useState<RankBy>(() => {
    const r = searchParams.get('rank');
    return (['volume', 'return', 'win', 'wilson', 'recent'] as string[]).includes(r ?? '') ? (r as RankBy) : 'profit';
  });
  const [minReturn, setMinReturn] = useState(() => {   // Return ≥ N% filter (0 = off, both tabs)
    const n = Number(searchParams.get('minRet'));
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const [humanOnly, setHumanOnly] = useState(() => searchParams.get('human') === '1');  // heuristic human-only (leaderboard)
  const [minResolved, setMinResolved] = useState(() => {   // Min resolved-markets filter (0 = off, both tabs)
    const n = Number(searchParams.get('minRes'));
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const [win, setWin]         = useState<WindowKey>('all');
  // Combined performance + activity filters (AND logic). Off by default; a collapsible bar.
  const [combined, setCombined]   = useState<CombinedFilters>(FILTERS_OFF);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [lbData, setLbData]   = useState<LbData | null>(null);
  const [error, setError]     = useState('');

  const [tier, setTier]       = useState<'free' | 'pro'>('free');
  const copy = useServerCopy();
  const maxSlots = copy.slots.limit;

  // Profile routing
  const [selected, setSelected]       = useState<LbEntry | null>(null);
  const [profile, setProfile]         = useState<TraderProfile | null>(null);
  const [profLoading, setProfLoading] = useState(false);
  const [profError, setProfError]     = useState('');

  // Copy-config panel target (opened from any COPY button).
  const [panelTarget, setPanelTarget] = useState<{ entry: LbEntry; profile: TraderProfile | null } | null>(null);
  const openPanel = useCallback((entry: LbEntry, prof: TraderProfile | null) => setPanelTarget({ entry, profile: prof }), []);

  // Canonical query string for the current section. `sel` (the open inline-profile
  // wallet) is threaded through in a STABLE position so every writer produces the
  // exact same string — mirror-replace, open-push and back-sync never fight over
  // ordering. Filter defaults are omitted for a clean URL.
  const sectionQuery = useCallback((sel?: string | null) => {
    const p = new URLSearchParams();
    if (tab !== 'leaderboard') p.set('tab', tab);
    if (cat !== 'All')         p.set('cat', cat);
    if (rankBy !== 'profit')   p.set('rank', rankBy);
    if (minReturn > 0)         p.set('minRet', String(minReturn));
    if (humanOnly)             p.set('human', '1');
    if (minResolved > 0)       p.set('minRes', String(minResolved));
    if (sel)                   p.set('sel', sel);
    return p.toString();
  }, [tab, cat, rankBy, minReturn, humanOnly, minResolved]);

  // Mirror the active section into the URL query so the origin history entry carries
  // the filter state (838386e). router.replace keeps ONE history entry (filter changes
  // don't stack), { scroll: false } so mirroring never fights ScrollToTop / scroll
  // restoration (baad0b8). We PRESERVE any live `sel` param so a filter re-sync never
  // silently drops the open-profile marker. No data/number touched.
  useEffect(() => {
    const qs = sectionQuery(searchParams.get('sel'));
    if (qs !== searchParams.toString()) {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [sectionQuery, pathname, router, searchParams]);

  // Opening an inline trader profile (TraderProfileView, rendered in place at the SAME
  // /dashboard/traders URL) must PUSH a history entry — otherwise the phone/browser BACK
  // button pops the whole traders-list entry and dumps the user on the landing page
  // instead of the list. We encode the open profile as ?sel=<wallet> (filters preserved)
  // so back removes it → the list re-shows with its 838386e filters, and a second back
  // goes to wherever the user came from. Route-based detail pages (feed-only wallets and
  // the "Live feed" Link) already push their own entry and are untouched.
  const pushSel = useCallback((wallet: string) => {
    router.push(`${pathname}?${sectionQuery(wallet)}`, { scroll: false });
  }, [router, pathname, sectionQuery]);

  // Back-sync: when the `sel` param is REMOVED by a navigation (phone/browser BACK, or
  // the in-page ← back button calling router.back()), close the inline drawer so the
  // list re-shows. Guarded by the previous value so it fires only on a genuine removal —
  // never on the transient render between setSelected() and the ?sel push during open.
  const prevSel = useRef<string | null>(null);
  useEffect(() => {
    const sel = searchParams.get('sel');
    if (prevSel.current && !sel && selected) setSelected(null);
    prevSel.current = sel;
  }, [searchParams, selected]);

  const loadLb = useCallback(async () => {
    try {
      const r = await fetch('/api/leaderboard');
      setLbData(await r.json());
    } catch (e: any) { setError(e.message || 'Failed to load leaderboard'); }
  }, []);

  useEffect(() => {
    loadLb();
    const t = setInterval(loadLb, 60_000);
    return () => clearInterval(t);
  }, [loadLb]);

  // Tier detection — reuses the server-side plan gate. 401 (unauth) → free.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/subscription');
        if (!r.ok) return;
        const d = await r.json();
        setTier(d.plan === 'pro' || d.plan === 'profit_share' ? 'pro' : 'free');
      } catch { /* stays free */ }
    })();
  }, []);

  async function openProfile(entry: LbEntry) {
    setSelected(entry);
    setProfile(null);
    setProfError('');
    setProfLoading(true);

    if (entry.hasProfile === false) {
      // agent20 hasn't built a heavy resolved-market profile for this wallet yet.
      // That is NOT the same as "no data" — agent30's live feed may still track it.
      // Honest-engine: probe the live feed. If it has a REAL record (200/ok), open
      // the live trade feed view DIRECTLY — no intermediate "open live trade feed"
      // notice/second click. Only when the wallet is absent from BOTH the profile
      // set AND the live feed do we show the honest empty-state (never redirect to a
      // blank/fabricated feed). The feed route 404s (or 503s while warming up) for a
      // truly-untracked wallet, which is the not-ok branch below.
      try {
        const r = await fetch(`/api/traders/feed/${entry.wallet.toLowerCase()}`, { cache: 'no-store' });
        const d = await r.json().catch(() => null);
        if (r.ok && d?.ok) {
          // Feed genuinely has data → go straight to the live feed detail page.
          // (Next navigation → global ScrollToTop lands the page at the top; baad0b8.)
          // Return WITHOUT clearing profLoading so the drawer shows a loading state,
          // not a null-profile flash, until the route unmounts this view.
          router.push(`/dashboard/traders/${entry.wallet.toLowerCase()}`);
          return;
        }
        // Absent from both the profile set and the live feed → honest empty-state.
        // Still an INLINE view (drawer over the list) → push its history entry so BACK
        // returns to the list, not the landing.
        pushSel(entry.wallet.toLowerCase());
        setProfError('No resolved-market leaderboard profile and no live trade feed for this wallet yet — it may not be in the tracked set, or the next resync will pick it up.');
      } catch {
        // Couldn't reach the feed to decide client-side — fall back to the honest
        // notice with its manual "Open live trade feed" link (harmless no-op fallback).
        pushSel(entry.wallet.toLowerCase());
        setProfError('No resolved-market leaderboard profile for this wallet yet — open its live trade feed for real fills & positions.');
      }
      setProfLoading(false);
      return;
    }

    // Inline resolved-market profile → push its ?sel history entry so the phone/browser
    // BACK button returns to the Traders list (with 838386e filters), not the landing.
    pushSel(entry.wallet.toLowerCase());
    try {
      const r = await fetch(`/api/leaderboard/profile/${entry.wallet.toLowerCase()}`);
      const d = await r.json();
      if (!r.ok || !d.profile) setProfError(d.error || 'Profile unavailable.');
      else setProfile(d.profile as TraderProfile);
    } catch (e: any) {
      setProfError(e.message || 'Network error');
    } finally {
      setProfLoading(false);
    }
  }

  const categoryKeys = useMemo(() => Object.keys(lbData?.categories ?? {}), [lbData]);

  // Ranking rules (honest-engine): see sortByRank — thin-sample floored, chosen
  // metric (profit / volume / return-on-volume) DESC, wilsonScore DESC tiebreak.
  // Then the Return ≥ N% threshold hides sub-threshold cards. Both compose on top
  // of the category slice, so category + sort + filter stack correctly.
  const rows = useMemo(() => {
    const list = sortByRank((lbData?.categories?.[cat] ?? []).slice(), rankBy);
    // Return ≥, then heuristic human-only, then min-resolved, then the combined
    // performance+activity bar — all AND-composed on REAL fields (honest-engine).
    return filterCombined(
      filterByMinResolved(filterByHuman(filterByMinReturn(list, minReturn), humanOnly), minResolved),
      combined);
  }, [lbData, cat, rankBy, minReturn, humanOnly, minResolved, combined]);

  // Bots / HFT wallets come from a dedicated server list — EXCLUDED from the
  // directional `categories` (so tiny-P&L scrapers can't fill the skill board).
  // The same rank-by + Return ≥ threshold apply here for a consistent UX. Human-only
  // is intentionally NOT applied here (this tab IS the bot list — its toggle is hidden).
  const bots = useMemo(() => {
    const list = sortByRank((lbData?.bots ?? []).slice(), rankBy);
    return filterCombined(filterByMinResolved(filterByMinReturn(list, minReturn), minResolved), combined);
  }, [lbData, rankBy, minReturn, minResolved, combined]);
  const botsTotal = lbData?.bots?.length ?? 0;

  // Window availability is DATA-DRIVEN, never a hardcoded list. A window renders
  // only if some served entry carries populated per-window data for it. 'all'
  // (all-time) is always present — the list itself IS the all-time ranking. Today
  // entries carry no windows{}, so only ALL qualifies and the selector row is
  // hidden entirely (no dead/disabled buttons). When agent20 backfills per-entry
  // windows{}, the extra buttons appear automatically. Honest-engine: we never
  // render all-time numbers under a 1D/7D/30D label.
  const availWindows = useMemo<WindowKey[]>(() => {
    const entries = Object.values(lbData?.categories ?? {}).flat();
    return (['1d', '7d', '30d', 'all'] as WindowKey[])
      .filter(k => k === 'all' || entries.some(e => e.windows?.[k] != null));
  }, [lbData]);

  const warmingUp = !lbData || (!lbData.ok && !lbData.updatedAt);
  const atLimit   = copy.count >= maxSlots;

  return (
    // .dsskin: appearance only — the leaderboard keeps its list, columns and sorting.
    <div className="dsskin max-w-[1100px] mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Eyebrow className="inline-flex items-center gap-1.5">
            <PlatformLogo platform="polymarket" size={12} />Polymarket · Top Traders
          </Eyebrow>
          <SectionHeading as="h1" className="text-3xl mt-1">Top Traders</SectionHeading>
          <p className="font-body text-sm text-muted mt-1.5">
            On-chain resolved P&amp;L · {lbData?.totalWallets ?? 0} wallets ranked · {lbData?.marketsScanned ?? 0} markets scanned
          </p>
        </div>
        <div className="flex flex-col items-end gap-0.5 font-body text-[11px]">
          {lbData?.stale
            ? <span className="text-gold">data {lbData.staleMinutes}m old · refreshing</span>
            : <span className="text-muted">{fmtUpdated(lbData?.updatedAt)}</span>}
          <span className="text-muted">{tier === 'pro' ? 'Pro' : 'Free'} · {copy.count}/{maxSlots} copy slots</span>
        </div>
      </div>

      {/* Tabs — hidden while an inline profile is open (the profile has its own ← back;
          this also avoids a tab-switch racing the ?sel back-sync). */}
      {!selected && (
        <div className="flex gap-0 border-b border-line mb-4">
          {(['leaderboard', 'bots', 'markets'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={[
                'px-4 py-2 font-body font-medium text-[11px] uppercase tracking-widest transition-colors relative',
                tab === t ? 'text-mint-deep' : 'text-muted hover:text-ink-2',
              ].join(' ')}>
              {t === 'leaderboard' ? 'Leaderboard' : t === 'bots' ? `Bots / HFT (${botsTotal})` : 'Markets'}
              {tab === t && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-mint-deep rounded-full" />}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="mb-3 px-3 py-2 border border-coral-ink/30 bg-coral-tint rounded-card font-body text-[11px] text-coral-ink">{error}</div>
      )}

      {warmingUp && tab !== 'markets' && (
        <div className="rounded-card border border-line bg-surface shadow-card p-8 text-center">
          <div className="font-body font-medium text-sm text-ink-2 mb-1">Agent warming up — scanning resolved markets…</div>
          <div className="font-body text-[11px] text-muted">First data in ~2–3 min.</div>
        </div>
      )}

      {/* ── Markets tab (Polymarket live markets by native category) ──────────────
          Independent of the leaderboard agent — self-fetches /api/poly-markets, so it
          renders even while the leaderboard is warming up. Public market prices,
          market-implied probability, indicative — no edge/ROI, no gating. */}
      {!selected && tab === 'markets' && <MarketsTab />}

      {/* ── Profile view ─────────────────────────────────────────────────────── */}
      {!warmingUp && selected && (
        <TraderProfileView
          entry={selected}
          profile={profile}
          loading={profLoading}
          error={profError}
          onBack={() => router.back()}
          copying={copy.isCopying(selected.wallet)}
          atLimit={atLimit && !copy.isCopying(selected.wallet)}
          tier={tier}
          maxSlots={maxSlots}
          onToggleCopy={() => openPanel(selected, profile)}
        />
      )}

      {/* ── Leaderboard tab ──────────────────────────────────────────────────── */}
      {!warmingUp && !selected && tab === 'leaderboard' && (
        <>
          {/* Rank-by (profit / volume / return %) + Return ≥ threshold + window.
              The window selector only renders windows that actually have data (see
              availWindows). With a single available window (today: all-time only)
              the whole selector is hidden, so users never see dead/disabled buttons. */}
          <RankControls
            rankBy={rankBy} setRankBy={setRankBy}
            minReturn={minReturn} setMinReturn={setMinReturn}
            humanOnly={humanOnly} setHumanOnly={setHumanOnly}
            minResolved={minResolved} setMinResolved={setMinResolved}
            showHuman
            right={availWindows.length > 1 ? (
              <div className="flex items-center gap-4">
                <span className="font-body text-[10px] uppercase tracking-wide text-muted">Window</span>
                {availWindows.map(w => (
                  <button key={w} onClick={() => setWin(w)}
                    className={[
                      'font-body text-[11px] uppercase tracking-wide pb-0.5 border-b-2 transition-colors',
                      win === w ? 'text-ink border-[#0c9d6e]' : 'text-muted border-transparent hover:text-ink-2',
                    ].join(' ')}>
                    {WINDOW_LABEL[w]}
                  </button>
                ))}
              </div>
            ) : null}
          />

          {/* Category chips — real API keys only */}
          <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1 scrollbar-none">
            {categoryKeys.map(c => {
              const count = lbData?.categories?.[c]?.length ?? 0;
              const active = c === cat;
              return (
                <button key={c} onClick={() => setCat(c)}
                  className={[
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-button border font-body font-medium text-[11px] uppercase tracking-wide whitespace-nowrap transition-colors shrink-0',
                    active ? 'border-mint-deep/40 bg-mint-tint text-mint-deep'
                           : 'border-line text-muted hover:border-mint-deep/30 hover:text-ink-2 bg-surface',
                  ].join(' ')}>
                  {c}
                  {count > 0 && (
                    <span className={`font-body text-[9px] px-1.5 py-0.5 rounded-pill ${active ? 'bg-mint-deep/20 text-mint-deep' : 'bg-line text-muted'}`}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Combined performance + activity filter bar (AND logic, real fields only) */}
          <AdvancedFilterBar
            open={showAdvanced} onToggle={() => setShowAdvanced(s => !s)}
            f={combined} setF={setCombined}
          />

          {rows.length === 0 ? (
            <div className="rounded-card border border-line bg-surface shadow-card p-8 text-center font-body text-sm text-muted">
              No traders match these filters.
            </div>
          ) : (
            <div className="rounded-card border border-line bg-surface shadow-card overflow-hidden">
              {rows.map((e, i) => (
                <LeaderRow key={e.wallet} e={e} rank={i + 1} cat={cat}
                  onOpen={() => openProfile(e)}
                  copying={copy.isCopying(e.wallet)}
                  atLimit={atLimit && !copy.isCopying(e.wallet)}
                  tier={tier} maxSlots={maxSlots}
                  onToggleCopy={() => openPanel(e, null)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Bots / HFT tab ───────────────────────────────────────────────────── */}
      {!warmingUp && !selected && tab === 'bots' && (
        <>
          <div className="mb-4 flex items-start gap-2 p-3 rounded-card border border-[#2f6fb0]/25 bg-[#2f6fb0]/[0.06]">
            <span className="font-body text-[11px] text-[#2f6fb0] leading-relaxed">
              Flagged by trade frequency, 5m/15m-market share, timing regularity, and 24/7 activity — an inference with confidence, not a Polymarket label.
            </span>
          </div>
          {/* Same rank-by (profit / volume / return %) + Return ≥ threshold as the
              leaderboard, for a consistent UX. No window selector on this tab. */}
          <RankControls
            rankBy={rankBy} setRankBy={setRankBy}
            minReturn={minReturn} setMinReturn={setMinReturn}
            humanOnly={humanOnly} setHumanOnly={setHumanOnly}
            minResolved={minResolved} setMinResolved={setMinResolved}
          />
          {bots.length === 0 ? (
            <div className="rounded-card border border-line bg-surface shadow-card p-8 text-center font-body text-sm text-muted">
              {botsTotal === 0
                ? 'No wallets flagged as bots in the current dataset.'
                : 'No bots match these filters.'}
            </div>
          ) : (
            <div className="rounded-card border border-line bg-surface shadow-card overflow-hidden">
              {bots.map((e, i) => (
                <BotRow key={e.wallet} e={e} rank={i + 1}
                  onOpen={() => openProfile(e)}
                  copying={copy.isCopying(e.wallet)}
                  atLimit={atLimit && !copy.isCopying(e.wallet)}
                  tier={tier} maxSlots={maxSlots}
                  onToggleCopy={() => openPanel(e, null)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Footer */}
      {!selected && tab !== 'markets' && (
        <p className="mt-6 font-body text-[11px] text-muted border-t border-line pt-4 leading-relaxed">
          Rankings from on-chain resolved Polymarket markets, ordered by the Wilson 95% lower-bound win rate (the
          solid bar); the light bar behind it is the raw win rate. Profit, % gain and volume are from resolved
          markets only; gross P&amp;L as Polymarket-reported, not net of gas. <span className="text-ink-2">% gain is
          return on volume</span> (profit ÷ volume traded) — not an ROI on capital, which we can&apos;t source.
          &ldquo;since&rdquo; is the earliest trade we&apos;ve tracked (≤2-yr window), a floor on tenure; last-trade
          is the most recent fill. Traders with under 20 resolved markets are withheld. Actor type (human/bot) is a
          heuristic inference from trade timing, never a platform label. Copy slots reserve a signal-follow only — no
          trade is executed. Past performance ≠ future results. Not financial advice.
        </p>
      )}

      {/* ── Copy-config panel (opens from any COPY button) ─────────────────────── */}
      {panelTarget && (
        <CopyConfigPanel
          wallet={panelTarget.entry.wallet}
          name={displayName(panelTarget.entry)}
          tier={tier}
          pnlUsdc={panelTarget.entry.pnlUsdc}
          winRate={panelTarget.entry.winRate}
          wilsonScore={panelTarget.entry.wilsonScore}
          resolvedMarkets={panelTarget.entry.resolvedMarkets}
          positionsOpen={panelTarget.profile?.positionsOpen}
          tradesClosed={panelTarget.profile?.tradesClosed}
          onClose={() => setPanelTarget(null)}
          onSaved={copy.reload}
        />
      )}
    </div>
  );
}

// ── Rank-by + Return ≥ threshold controls (shared by both tabs) ─────────────────
// Rank by profit / volume / return-on-volume, plus a "Return ≥ N%" threshold that
// hides sub-threshold cards. `right` is an optional slot (leaderboard window
// selector). Look matches the existing rank-by / category chip tokens.
function RankControls({
  rankBy, setRankBy, minReturn, setMinReturn,
  humanOnly, setHumanOnly, minResolved, setMinResolved, showHuman = false, right,
}: {
  rankBy: RankBy; setRankBy: (r: RankBy) => void;
  minReturn: number; setMinReturn: (n: number) => void;
  humanOnly: boolean; setHumanOnly: (b: boolean) => void;
  minResolved: number; setMinResolved: (n: number) => void;
  showHuman?: boolean;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 flex-wrap mb-3">
      <div className="flex items-center gap-4 flex-wrap">
        <span className="font-body text-[10px] uppercase tracking-wide text-muted">Rank by</span>
        {RANK_ORDER.map(r => (
          <button key={r} onClick={() => setRankBy(r)}
            title={RANK_TITLE[r]}
            className={[
              'font-body text-[11px] uppercase tracking-wide pb-0.5 border-b-2 transition-colors',
              rankBy === r ? 'text-ink border-[#0c9d6e]' : 'text-muted border-transparent hover:text-ink-2',
            ].join(' ')}>
            {RANK_LABEL[r]}
          </button>
        ))}
        {/* Return ≥ N% threshold — 0 shows all (incl. entries with no return). */}
        <span className="h-3.5 w-px bg-line shrink-0" aria-hidden />
        <label className="flex items-center gap-1.5 whitespace-nowrap"
          title="Show only cards whose return on volume (profit ÷ volume) is at least this %">
          <span className="font-body text-[10px] uppercase tracking-wide text-muted">Return ≥</span>
          <input
            type="number" inputMode="decimal" min={0} step={1}
            value={minReturn === 0 ? '' : minReturn}
            placeholder="0"
            onChange={e => {
              const n = Number(e.target.value);
              setMinReturn(Number.isFinite(n) && n > 0 ? n : 0);
            }}
            className="w-14 px-1.5 py-0.5 rounded-button border border-line bg-surface text-ink font-mono text-[11px] tabular-nums text-right focus:outline-none focus:border-mint-deep/50"
          />
          <span className="font-body text-[10px] text-muted">%</span>
        </label>
        {/* Min resolved-markets — hides thin-sample wallets (public count, every tier). */}
        <label className="flex items-center gap-1.5 whitespace-nowrap"
          title="Show only wallets with at least this many resolved markets (a public count — filters out thin, noisy samples)">
          <span className="font-body text-[10px] uppercase tracking-wide text-muted">Resolved ≥</span>
          <input
            type="number" inputMode="numeric" min={0} step={5}
            value={minResolved === 0 ? '' : minResolved}
            placeholder="0"
            onChange={e => {
              const n = Number(e.target.value);
              setMinResolved(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
            }}
            className="w-14 px-1.5 py-0.5 rounded-button border border-line bg-surface text-ink font-mono text-[11px] tabular-nums text-right focus:outline-none focus:border-mint-deep/50"
          />
        </label>
        {/* Human-only (heuristic) — leaderboard only; hidden on the bots tab. */}
        {showHuman && (
          <button onClick={() => setHumanOnly(!humanOnly)}
            title="Show only wallets NOT heuristically flagged as bots (an inference from trade frequency/timing — not a Polymarket label)"
            className={[
              'font-body text-[11px] uppercase tracking-wide px-2 py-0.5 rounded-button border transition-colors',
              humanOnly ? 'text-[#0c9d6e] border-[#0c9d6e]/50 bg-mint-tint' : 'text-muted border-line hover:text-ink-2',
            ].join(' ')}>
            Human only
          </button>
        )}
      </div>
      {right}
    </div>
  );
}

// ── Leaderboard row ────────────────────────────────────────────────────────────

interface RowProps {
  e: LbEntry; rank: number; onOpen: () => void;
  copying: boolean; atLimit: boolean; tier: 'free' | 'pro'; maxSlots: number; onToggleCopy: () => void;
}

// Small labelled figure for the stat strip. value is pre-formatted (already '—' when
// redacted/absent) — the strip never fabricates a number.
function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="font-body text-[9px] uppercase tracking-wide text-muted/70">{label}</span>
      <span className="font-mono text-[11px] text-ink-2 tabular-nums">{children}</span>
    </span>
  );
}

// ── Combined performance + activity filter bar ─────────────────────────────────
// Real agent20 fields only (AND-composed). Sharpe / max-drawdown / avg-hold are shown
// as "—  profile-only" (disabled) because agent20 does NOT compute them at list level —
// honest-engine: never a filter that would fabricate or empty the list on missing data.
function AdvancedFilterBar({
  open, onToggle, f, setF,
}: { open: boolean; onToggle: () => void; f: CombinedFilters; setF: (u: CombinedFilters) => void }) {
  const active = filtersActive(f);
  const num = (v: string) => (v === '' ? NaN : Number(v));
  return (
    <div className="mb-4 rounded-card border border-line bg-surface shadow-card overflow-hidden">
      <button onClick={onToggle} className="w-full min-h-[44px] px-4 flex items-center justify-between gap-2">
        <span className="font-body text-[12px] font-medium text-ink-2">
          Filters — performance + activity {active && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-pill bg-mint-tint text-mint-deep">active</span>}
        </span>
        <span className="font-body text-[11px] text-muted">{open ? 'hide ▲' : 'show ▼'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-line grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          {/* Performance */}
          <RangeRow label="Win rate %" unit="%" min={f.winMin} max={f.winMax} lo={0} hi={100}
            onMin={v => setF({ ...f, winMin: Number.isFinite(num(v)) ? Math.max(0, num(v)) : 0 })}
            onMax={v => setF({ ...f, winMax: Number.isFinite(num(v)) ? Math.min(100, num(v)) : 100 })} />
          <RangeRow label="Wilson score" min={f.wilMin} max={f.wilMax} lo={0} hi={1} step={0.01}
            onMin={v => setF({ ...f, wilMin: Number.isFinite(num(v)) ? Math.max(0, num(v)) : 0 })}
            onMax={v => setF({ ...f, wilMax: Number.isFinite(num(v)) ? Math.min(1, num(v)) : 1 })} />
          <RangeRow label="Return on volume %" unit="%" min={f.roiMin} max={f.roiMax} lo={-100} hi={100}
            onMin={v => setF({ ...f, roiMin: Number.isFinite(num(v)) ? num(v) : -100 })}
            onMax={v => setF({ ...f, roiMax: Number.isFinite(num(v)) ? num(v) : 100 })} />
          {/* Activity */}
          <RangeRow label="Volume $ (min)" min={f.volMin} max={f.volMax} lo={0} hi={0} singleMin
            onMin={v => setF({ ...f, volMin: Number.isFinite(num(v)) ? Math.max(0, num(v)) : 0 })}
            onMax={() => {}} />
          <div className="flex items-center gap-4 flex-wrap">
            <label className="inline-flex items-center gap-2 font-body text-[12px] text-ink-2 min-h-[44px]">
              <input type="checkbox" checked={f.verifiedOnly} onChange={e => setF({ ...f, verifiedOnly: e.target.checked })} style={{ accentColor: '#0c9d6e' }} />
              Verified only
            </label>
            <label className="inline-flex items-center gap-2 font-body text-[12px] text-ink-2 min-h-[44px]">
              <input type="checkbox" checked={f.active24h} onChange={e => setF({ ...f, active24h: e.target.checked })} style={{ accentColor: '#0c9d6e' }} />
              Active in last 24h
            </label>
          </div>
          {/* Honest "not available at list level" */}
          <div className="sm:col-span-2 flex items-center gap-3 flex-wrap pt-1 border-t border-line/60">
            <span className="font-body text-[10px] text-muted">Sharpe, max drawdown, avg hold: <span className="text-faint">—  profile-only (no list-level series; not filtered here rather than faked)</span></span>
            {active && (
              <button onClick={() => setF(FILTERS_OFF)} className="ml-auto font-body text-[11px] text-mint-deep hover:underline">reset filters</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RangeRow({ label, unit, min, max, lo, hi, step, singleMin, onMin, onMax }: {
  label: string; unit?: string; min: number; max: number; lo: number; hi: number; step?: number;
  singleMin?: boolean; onMin: (v: string) => void; onMax: (v: string) => void;
}) {
  const box = 'w-20 min-w-0 min-h-[36px] rounded-lg border border-line bg-bg/40 px-2 font-mono text-[12px] text-ink tabular-nums';
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="font-body text-[11px] text-muted w-32 shrink-0">{label}</span>
      <input type="number" defaultValue={min !== lo ? String(min) : ''} placeholder={`min${unit ?? ''}`} step={step} onChange={e => onMin(e.target.value)} className={box} />
      {!singleMin && (<>
        <span className="text-faint">–</span>
        <input type="number" defaultValue={max !== hi ? String(max) : ''} placeholder={`max${unit ?? ''}`} step={step} onChange={e => onMax(e.target.value)} className={box} />
      </>)}
    </div>
  );
}

// Deep-link into the live per-trader detail page (agent30 feed). Distinct tap
// target with stopPropagation so it never triggers the row's profile panel.
function LiveFeedLink({ wallet }: { wallet: string }) {
  return (
    <Link
      href={`/dashboard/traders/${wallet.toLowerCase()}`}
      onClick={(ev) => ev.stopPropagation()}
      title="Open live trade feed"
      className="inline-flex items-center gap-1 rounded-md border border-line bg-bg-soft px-1.5 py-[2px] text-[10px] font-body text-muted hover:text-mint-deep hover:border-mint-deep/40 transition-colors">
      <Activity size={11} className="shrink-0" /> Live feed
    </Link>
  );
}

function LeaderRow({ e, rank, cat, onOpen, copying, atLimit, tier, maxSlots, onToggleCopy }: RowProps & { cat: string }) {
  const low     = isLowSample(e.resolvedMarkets);
  const gainPct = returnOnVolumePct(e.pnlUsdc, e.volumeUsdc);   // profit ÷ volume (return on volume)
  // Category chip reflects the current board slice this trader qualifies in (entries carry
  // no per-trader category — we never invent one). Neutral chip on the "All" board.
  const chipCat = cat && cat !== 'All' ? cat : null;
  return (
    <div onClick={onOpen}
      className="flex items-center gap-3 px-4 py-3.5 border-b border-line last:border-b-0 hover:bg-bg-soft/40 cursor-pointer transition-colors">
      <span className="font-body text-[12px] text-muted tabular-nums w-7 shrink-0 text-center">
        {rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : rank}
      </span>

      <div className="min-w-0 flex-1">
        {/* line 1 — identity + freshness */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-body font-semibold text-sm text-ink truncate">{displayName(e)}</span>
          <VerifiedTick show={e.verified} />
          {chipCat && <CategoryTag label={chipCat} colorClass={catText(chipCat)} />}
          <ActorBadge actor={e.actorType} />
          {e.walletType === 'MM' && (
            <span className="font-body text-[9px] font-medium px-1.5 py-[2px] rounded-md border border-gold/40 text-gold bg-gold-tint uppercase tracking-wide">MM</span>
          )}
          {low && <LowSampleBadge n={e.resolvedMarkets} />}
          <span className="ml-auto pl-2"><FreshnessChip lastActive={e.lastActive} /></span>
        </div>

        {/* line 2 — two-level win-rate bar (Wilson solid · raw light) */}
        <div className="mt-2 max-w-[340px]">
          <WinRateBar winRate={e.winRate} wilson={e.wilsonScore} resolvedMarkets={e.resolvedMarkets} />
        </div>

        {/* line 3 — stat strip */}
        <div className="flex items-center gap-x-3 gap-y-1 mt-1.5 flex-wrap">
          {/* WIN RATE {floor}% ({raw}% raw) — floor = Wilson 95% lower bound (ranked
              metric), raw = unadjusted %. Same two real numbers, label only. The
              identity line already carries the low-sample badge, so omit it here. */}
          <WinRateLabel winRate={e.winRate} wilson={e.wilsonScore} resolvedMarkets={e.resolvedMarkets} />
          <Stat label="resolved">{e.resolvedMarkets}</Stat>
          <Stat label="vol"><Redacted value={e.volumeUsdc}>{v => fmtVol(v)}</Redacted></Stat>
          <Stat label="since">{fmtSince(e.firstActive)}</Stat>
          <LiveFeedLink wallet={e.wallet} />
          {(() => { const u = polymarketProfileUrl(e.wallet); return u ? <PlatformLink href={u} label="↗" compact /> : null; })()}
        </div>
      </div>

      {/* right — profit + % gain (return on volume) */}
      <div className="text-right shrink-0 w-[92px]">
        <div className={`font-display font-bold text-base tabular-nums ${pnlColor(e.pnlUsdc)}`}>
          <Redacted value={e.pnlUsdc}>{v => fmtPnl(v)}</Redacted>
        </div>
        <div className="font-body text-[10px] text-muted tabular-nums mt-0.5"
          title="return on volume = profit ÷ volume traded (not an ROI on capital)">
          {gainPct != null ? `${fmtPct1(gainPct)} on vol` : <span className="text-muted/60">—</span>}
        </div>
      </div>

      <div className="shrink-0" onClick={(ev) => ev.stopPropagation()}>
        <CopyButton copying={copying} atLimit={atLimit} tier={tier} maxSlots={maxSlots} onToggle={onToggleCopy} />
      </div>
    </div>
  );
}

// ── Bot row ────────────────────────────────────────────────────────────────────

function BotRow({ e, rank, onOpen, copying, atLimit, tier, maxSlots, onToggleCopy }: RowProps) {
  const conf = e.actorType?.confidence ?? 0;
  const signals = (e.actorType?.signals ?? []).slice(0, 3);
  const gainPct = returnOnVolumePct(e.pnlUsdc, e.volumeUsdc);   // profit ÷ volume (return on volume) — same field as the leaderboard
  return (
    <div onClick={onOpen}
      className="px-4 py-3 border-b border-line last:border-b-0 hover:bg-bg-soft/40 cursor-pointer transition-colors">
      <div className="flex items-center gap-3">
        <span className="font-body text-[11px] text-muted tabular-nums w-7 shrink-0 text-center">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-body font-medium text-sm text-ink truncate">{displayName(e)}</span>
            <ActorBadge actor={e.actorType} />
          </div>
          <div className="flex items-center gap-2 mt-0.5 font-body text-[10px] text-muted">
            <span>{fmtWallet(e.wallet)} · {e.resolvedMarkets} resolved</span>
            <LiveFeedLink wallet={e.wallet} />
            {(() => { const u = polymarketProfileUrl(e.wallet); return u ? <PlatformLink href={u} label="Polymarket profile" compact /> : null; })()}
            <WinRateLabel winRate={e.winRate} wilson={e.wilsonScore} resolvedMarkets={e.resolvedMarkets} lowSampleBadge />
          </div>
        </div>
        <div className="text-right shrink-0 w-20">
          <div className={`font-display font-bold text-base tabular-nums ${pnlColor(e.pnlUsdc)}`}>
            <Redacted value={e.pnlUsdc}>{v => fmtPnl(v)}</Redacted>
          </div>
          <div className="font-body text-[10px] text-muted tabular-nums mt-0.5"
            title="return on volume = profit ÷ volume traded (not an ROI on capital)">
            {gainPct != null ? `${fmtPct1(gainPct)} on vol` : <span className="text-muted/60">—</span>}
          </div>
        </div>
        <div className="shrink-0" onClick={(ev) => ev.stopPropagation()}>
          <CopyButton copying={copying} atLimit={atLimit} tier={tier} maxSlots={maxSlots} onToggle={onToggleCopy} />
        </div>
      </div>
      <div className="mt-2 pl-10 flex flex-col gap-2">
        <div className="max-w-[240px]"><ConfidenceBar pct={conf} /></div>
        {signals.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {signals.map((s, i) => (
              <span key={i} className="font-body text-[9px] text-[#2f6fb0] px-1.5 py-0.5 rounded-md border border-[#2f6fb0]/25 bg-[#2f6fb0]/[0.06]">{s}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
