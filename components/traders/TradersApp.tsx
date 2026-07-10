'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link           from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Activity }   from 'lucide-react';
import Eyebrow        from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import PlatformLogo   from '@/components/PlatformLogo';
import { Redacted }   from '@/app/components/ui/Redacted';
import { PlatformLink } from '@/app/components/ui/PlatformLink';
import { polymarketProfileUrl } from '@/lib/platform-links';
import { ActorBadge, VerifiedTick, WinRate, WinRateBar, FreshnessChip, LowSampleBadge, CategoryTag, ConfidenceBar, CopyButton } from './parts';
import TraderProfileView from './TraderProfile';
import CopyConfigPanel from './CopyConfigPanel';
import {
  fmtPnl, fmtVol, fmtWallet, fmtUpdated, fmtSince, fmtPct1, returnOnVolumePct,
  displayName, pnlColor, catText, isLowSample,
  type LbData, type LbEntry, type TraderProfile, type WindowKey,
} from './format';

type Tab = 'leaderboard' | 'bots';
type RankBy = 'profit' | 'volume' | 'return';

const RANK_LABEL: Record<RankBy, string> = { profit: 'profit', volume: 'volume', return: 'return %' };

// The metric a given rank-by key ranks on, for a single entry. Reuses the EXACT
// field shown on the card: return === returnOnVolumePct(pnl, vol) (the "+X% on vol"
// figure). Returns null when the value is unavailable (e.g. vol ≤ 0) so the caller
// floors it last — never a fabricated number. Profit/volume math is untouched.
function rankMetric(e: LbEntry, rankBy: RankBy): number | null {
  if (rankBy === 'return') return returnOnVolumePct(e.pnlUsdc, e.volumeUsdc);
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
  const [tab, setTab]         = useState<Tab>(() => (searchParams.get('tab') === 'bots' ? 'bots' : 'leaderboard'));
  const [cat, setCat]         = useState(() => searchParams.get('cat') || 'All');
  const [rankBy, setRankBy]   = useState<RankBy>(() => {
    const r = searchParams.get('rank');
    return r === 'volume' || r === 'return' ? r : 'profit';
  });
  const [minReturn, setMinReturn] = useState(() => {   // Return ≥ N% filter (0 = off, both tabs)
    const n = Number(searchParams.get('minRet'));
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const [win, setWin]         = useState<WindowKey>('all');
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

  // Mirror the active section into the URL query (defaults omitted → clean URL) so
  // the origin history entry carries the filter state. router.replace keeps ONE
  // history entry (filter changes don't stack), and { scroll: false } so mirroring
  // never fights ScrollToTop / scroll restoration (baad0b8). No data/number touched.
  useEffect(() => {
    const p = new URLSearchParams();
    if (tab !== 'leaderboard') p.set('tab', tab);
    if (cat !== 'All')         p.set('cat', cat);
    if (rankBy !== 'profit')   p.set('rank', rankBy);
    if (minReturn > 0)         p.set('minRet', String(minReturn));
    const qs = p.toString();
    if (qs !== searchParams.toString()) {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [tab, cat, rankBy, minReturn, pathname, router, searchParams]);

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
        setProfError('No resolved-market leaderboard profile and no live trade feed for this wallet yet — it may not be in the tracked set, or the next resync will pick it up.');
      } catch {
        // Couldn't reach the feed to decide client-side — fall back to the honest
        // notice with its manual "Open live trade feed" link (harmless no-op fallback).
        setProfError('No resolved-market leaderboard profile for this wallet yet — open its live trade feed for real fills & positions.');
      }
      setProfLoading(false);
      return;
    }

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
    return filterByMinReturn(list, minReturn);
  }, [lbData, cat, rankBy, minReturn]);

  // Bots / HFT wallets come from a dedicated server list — EXCLUDED from the
  // directional `categories` (so tiny-P&L scrapers can't fill the skill board).
  // The same rank-by + Return ≥ threshold apply here for a consistent UX.
  const bots = useMemo(() => {
    const list = sortByRank((lbData?.bots ?? []).slice(), rankBy);
    return filterByMinReturn(list, minReturn);
  }, [lbData, rankBy, minReturn]);
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
    <div className="max-w-[1100px] mx-auto px-4 py-8">
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

      {/* Tabs */}
      <div className="flex gap-0 border-b border-line mb-4">
        {(['leaderboard', 'bots'] as Tab[]).map(t => (
          <button key={t} onClick={() => { setTab(t); setSelected(null); }}
            className={[
              'px-4 py-2 font-body font-medium text-[11px] uppercase tracking-widest transition-colors relative',
              tab === t ? 'text-mint-deep' : 'text-muted hover:text-ink-2',
            ].join(' ')}>
            {t === 'leaderboard' ? 'Leaderboard' : `Bots / HFT (${botsTotal})`}
            {tab === t && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-mint-deep rounded-full" />}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 border border-coral-ink/30 bg-coral-tint rounded-card font-body text-[11px] text-coral-ink">{error}</div>
      )}

      {warmingUp && (
        <div className="rounded-card border border-line bg-surface shadow-card p-8 text-center">
          <div className="font-body font-medium text-sm text-ink-2 mb-1">Agent warming up — scanning resolved markets…</div>
          <div className="font-body text-[11px] text-muted">First data in ~2–3 min.</div>
        </div>
      )}

      {/* ── Profile view ─────────────────────────────────────────────────────── */}
      {!warmingUp && selected && (
        <TraderProfileView
          entry={selected}
          profile={profile}
          loading={profLoading}
          error={profError}
          onBack={() => setSelected(null)}
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
      {!selected && (
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
  rankBy, setRankBy, minReturn, setMinReturn, right,
}: {
  rankBy: RankBy; setRankBy: (r: RankBy) => void;
  minReturn: number; setMinReturn: (n: number) => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 flex-wrap mb-3">
      <div className="flex items-center gap-4">
        <span className="font-body text-[10px] uppercase tracking-wide text-muted">Rank by</span>
        {(['profit', 'volume', 'return'] as RankBy[]).map(r => (
          <button key={r} onClick={() => setRankBy(r)}
            title={r === 'return' ? 'return on volume = profit ÷ volume traded (not an ROI on capital)' : undefined}
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
          <Stat label="floor"><Redacted value={e.wilsonScore}>{v => `${Math.round(v * 100)}%`}</Redacted></Stat>
          <Stat label="raw"><Redacted value={e.winRate}>{v => `${v.toFixed(0)}%`}</Redacted></Stat>
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
            <WinRate winRate={e.winRate} wilson={e.wilsonScore} resolvedMarkets={e.resolvedMarkets} />
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
