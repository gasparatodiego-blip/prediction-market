'use client';

// Liquidity Rewards — professional light, filter-rich board (matches the
// sports / paper / traders / carry / prediction redesign pattern).
// Every number is wired to the live unified snapshot (/api/rewards-unified ←
// /tmp/liquidity-rewards.json) and lib/rewards-estimate.ts (the honest SSOT).
//
// HONEST-ENGINE (all reused, never re-derived here):
//   • The forward reward is NOT deterministic → it is shown ONLY as the
//     adverse-fill-subtracted `est net/day`, always labeled an estimate, never a
//     guaranteed/realized P&L. There is no per-market realized-accrued field →
//     that row is OMITTED (never fabricated).
//   • estimateReward WITHHOLDS net (null) when the run-rate exceeds the 200%/yr
//     sanity cap or modeled gross exceeds the real book depth — a thin-book
//     inflated rate renders MUTED "suppressed — implausible rate", never a shiny
//     number (this is the gate that killed the fake 1479$/day 100%-share bug).
//   • qualifyingLiquidity===0 is treated as UNMEASURED, not "no competitors" —
//     net is withheld with that honest note, never a fabricated 100%-share figure.
//   • Free tier: the server nulls every executable field → <Redacted> lock; the
//     estimator degrades to the calm "unlock" state. Public fields stay visible.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, ExternalLink } from 'lucide-react';
import Eyebrow from '@/app/components/ui/Eyebrow';
import InfoTip from '@/app/components/ui/InfoTip';
import SectionHeading from '@/app/components/ui/SectionHeading';
import StatCard from '@/app/components/ui/StatCard';
import PlatformLogo from '@/components/PlatformLogo';
import RewardsHero from '@/app/components/ui/RewardsHero';
import { Redacted } from '@/app/components/ui/Redacted';
import { PlatformLink } from '@/app/components/ui/PlatformLink';
import { VerifyBadge } from '@/app/components/ui/VerifyBadge';
import { polymarketMarketUrl, polymarketOutcomeUrl, kalshiMarketUrl } from '@/lib/platform-links';
import { estimateReward, type MarketSnapshot, type SideSnapshot, type Venue, type EstimateResult } from '@/lib/rewards-estimate';

// Trading-side selector for the list: 'both' = legacy single-book behavior; 'yes'/'no'
// rank + estimate every card from that side's real book.
type TradeSideFilter = 'both' | 'yes' | 'no';

// Real platform deep-link for a reward market: Polymarket event (from slug) or
// Kalshi market (from ticker). Returns null when the id needed is absent — the row
// then renders no link (honest-engine: never a fabricated URL).
function rewardMarketUrl(m: { venue: Venue; slug?: string | null; marketSlug?: string | null; negRisk?: boolean; marketId: string }): string | null {
  if (m.venue === 'polymarket') {
    if (m.negRisk && m.marketSlug) {
      const outcome = polymarketOutcomeUrl(m.slug, m.marketSlug);
      if (outcome) return outcome;
    }
    return polymarketMarketUrl(m.slug);
  }
  if (m.venue === 'kalshi')     return kalshiMarketUrl(m.marketId);
  return null;
}

// ── Types (mirror /api/rewards-unified) ─────────────────────────────────────
type NewsRisk = 'low' | 'medium' | 'high' | 'unknown';

interface NormalizedMarket {
  venue:               Venue;
  marketId:            string;
  slug?:               string | null;
  marketSlug?:         string | null;
  groupItemTitle?:     string | null;
  negRisk?:            boolean;
  title:               string;
  category:            string;
  midpoint:            number | null;
  maxSpread:           number | null;
  minSize:             number | null;
  dailyPool:           number | null;
  qualifyingLiquidity: number | null;
  bookDepthAtBand:     number | null;
  hoursToResolution:   number | null;
  updatedAt:           string | null;
  volatilityStdev:     number | null;
  volatilityRisk:      string | null;
  lastPrice:           number | null;
  twoSidedRequired:    boolean;
  bookSpread:          number | null;
  scoringModel:        string;
  flags:               string[];
  tokenId:             string | null;
  tokenIdNo?:          string | null;
  sides?:              { yes: SideSnapshot | null; no: SideSnapshot | null } | null;
  newsRisk?:           NewsRisk;
  newsSignals?:        { source: string; note: string }[] | null;
  protect?:            { action: string; detail: string } | null;
}

interface UnifiedResponse {
  meta: {
    generatedAt: string;
    totalMarkets: number;
    polymarket: number;
    kalshi: number;
    withRealPool: number;
    poolUnknown: number;
  } | null;
  markets: NormalizedMarket[];
  stale: boolean;
  error?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────
const POLL_MS = 5 * 60_000;
const DEFAULT_CAPITAL = 1000;

// ── Small helpers ────────────────────────────────────────────────────────────
function ago(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}
function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  if (n >= 10)        return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}
function fmtHours(h: number | null): string {
  if (h == null) return '—';
  if (h < 48)  return `${h.toFixed(0)}h`;
  return `${(h / 24).toFixed(0)}d`;
}
function toSnapshot(m: NormalizedMarket): MarketSnapshot {
  return {
    venue: m.venue,
    midpoint: m.midpoint,
    maxSpread: m.maxSpread,
    minSize: m.minSize,
    dailyPool: m.dailyPool,
    qualifyingLiquidity: m.qualifyingLiquidity,
    bookDepthAtBand: m.bookDepthAtBand,
    volatilityStdev: m.volatilityStdev,
    twoSidedRequired: m.twoSidedRequired,
    sides: m.sides ?? null,
  };
}
// Full honest estimate for a card, from the chosen side's REAL book. This is the
// SSOT — every headline/detail number below reads off this result, nothing is
// recomputed. `netPerDay` is null when the lib withheld it (unmeasured / pool
// unknown / too-good-to-verify) — the UI shows that state honestly, never a value.
function fullEst(m: NormalizedMarket, side: TradeSideFilter): EstimateResult {
  const dist = (m.maxSpread ?? 2) / 2;
  return estimateReward({
    venue: m.venue, capital: DEFAULT_CAPITAL, twoSided: true, distanceCents: dist,
    market: toSnapshot(m), side: side === 'both' ? undefined : side,
  });
}
function typicalNet(m: NormalizedMarket, side: TradeSideFilter): number | null {
  return fullEst(m, side).netPerDay;
}
// The mid a card headlines depends on the selected side (YES=mid, NO=1−mid / sides.no).
function sideMid(m: NormalizedMarket, side: TradeSideFilter): number | null {
  if (side === 'yes') return m.sides?.yes?.midpoint ?? m.midpoint;
  if (side === 'no')  return m.sides?.no?.midpoint ?? (m.midpoint != null ? 1 - m.midpoint : null);
  return m.midpoint;
}
function sideDepth(m: NormalizedMarket, side: TradeSideFilter): number | null {
  if (side === 'yes') return m.sides?.yes?.bookDepthAtBand ?? m.bookDepthAtBand;
  if (side === 'no')  return m.sides?.no?.bookDepthAtBand ?? m.bookDepthAtBand;
  return m.bookDepthAtBand;
}
function sideQual(m: NormalizedMarket, side: TradeSideFilter): number | null {
  if (side === 'yes') return m.sides?.yes?.qualifyingLiquidity ?? m.qualifyingLiquidity;
  if (side === 'no')  return m.sides?.no?.qualifyingLiquidity ?? m.qualifyingLiquidity;
  return m.qualifyingLiquidity;
}
// Free tier nulls every executable field; if ANY is present we're on the paid tier
// and a null estimate is an honest "withheld", not a paywall lock.
function isRevealed(m: NormalizedMarket): boolean {
  return m.midpoint != null || m.dailyPool != null || m.qualifyingLiquidity != null || m.bookDepthAtBand != null;
}
// Why a revealed (paid-tier) net came back null — classify the estimator's own
// reasons into a short honest note. The too-good/thin-book cases read as a MUTED
// "suppressed" state, never a number.
function withheldNote(est: EstimateResult): { text: string; suppressed: boolean } {
  const r = est.reasons.join(' ');
  if (/sanity cap|dominate this thin|exceeds the real book depth/i.test(r)) return { text: 'suppressed — implausible rate (thin book)', suppressed: true };
  if (/qualifying liquidity reads zero/i.test(r))                           return { text: 'withheld — competition unmeasured', suppressed: false };
  if (/qualifying liquidity unknown/i.test(r))                             return { text: 'withheld — competition unknown', suppressed: false };
  if (/pool unknown/i.test(r))                                             return { text: 'pool not published', suppressed: false };
  if (/book depth unknown/i.test(r))                                       return { text: 'withheld — book depth unknown', suppressed: false };
  if (/adverse-selection cost unknown/i.test(r))                           return { text: 'withheld — risk unquantified', suppressed: false };
  if (/single-sided order scores 0/i.test(r))                             return { text: 'two-sided required here', suppressed: false };
  return { text: 'not computable', suppressed: false };
}

// ── News-risk badge ──────────────────────────────────────────────────────────
function NewsBadge({ risk }: { risk: NewsRisk }) {
  const map: Record<NewsRisk, { label: string; cls: string; title: string }> = {
    high:    { label: 'news risk · HIGH', cls: 'bg-coral-tint text-coral-ink border-coral-ink/25', title: 'Breaking signal or volatility spike — the guard advises withdrawing liquidity.' },
    medium:  { label: 'news risk · med',  cls: 'bg-gold-tint text-gold border-gold/25',           title: 'Elevated chatter/volatility around this event — watch closely.' },
    low:     { label: 'calm',             cls: 'bg-mint-tint text-mint-deep border-mint-deep/20',  title: 'No adverse news/volatility signal detected right now.' },
    unknown: { label: 'no signal',        cls: 'bg-bg-soft text-muted border-line',                title: 'News-guard has no reading for this market yet.' },
  };
  const s = map[risk] ?? map.unknown;
  return (
    <span title={s.title} className={`inline-flex items-center px-2 py-[2px] rounded-md font-body font-medium text-[10px] border ${s.cls}`}>
      {s.label}
    </span>
  );
}

// ── Explainer block ──────────────────────────────────────────────────────────
function Explainer() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      <button className="w-full flex items-center justify-between px-5 py-4 text-left" onClick={() => setOpen(v => !v)}>
        <span className="font-body font-medium text-sm text-ink-2">What are liquidity rewards? (start here)</span>
        <span className="font-body text-[11px] text-muted">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 border-t border-line space-y-4">
          <p className="font-body text-[13px] text-ink-2 leading-relaxed mt-4">
            Both Polymarket and Kalshi <span className="font-medium text-ink">pay you daily just for posting limit orders near the middle price</span> —
            even if nobody trades against them. You&apos;re providing liquidity, and the exchange rewards you from a pool for it.
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-button bg-bg-soft border border-line px-4 py-3">
              <div className="flex items-center gap-2 mb-1"><PlatformLogo platform="polymarket" size={14} /><span className="font-body font-medium text-[12px] text-ink">Polymarket</span></div>
              <p className="font-body text-[12px] text-muted leading-relaxed">Rewards pool &gt;$5M/month. Score = size × closeness-to-mid (quadratic) × time resting. Two-sided pays more and is <span className="text-ink-2">required</span> when the price is below 10¢ or above 90¢. Paid daily ~midnight UTC, $1/day minimum.</p>
            </div>
            <div className="rounded-button bg-bg-soft border border-line px-4 py-3">
              <div className="flex items-center gap-2 mb-1"><PlatformLogo platform="kalshi" size={14} /><span className="font-body font-medium text-[12px] text-ink">Kalshi</span></div>
              <p className="font-body text-[12px] text-muted leading-relaxed">Liquidity Incentive Program, $10–$1,000 per market per day, through Sep&nbsp;1&nbsp;2026. Per-second book snapshots; your order must rest the whole second. Two-sided required to score. Payout = your score ÷ total score × pool.</p>
            </div>
          </div>
          <div className="rounded-button bg-coral-tint/50 border border-coral-ink/20 px-4 py-3">
            <p className="font-body text-[12px] text-coral-ink leading-relaxed">
              <span className="font-semibold">Not free money, and not guaranteed.</span> When your resting order gets filled it&apos;s usually because the
              price is about to move against you (adverse selection). Every <span className="font-medium">est net/day</span> below already subtracts the expected adverse-fill cost —
              but it is a forward <span className="font-medium">estimate</span>, never a realized or locked return. Your actual pool share depends on who else is quoting.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Filter/sort primitives (match the prediction/carry redesign) ──────────────
type SortKey = 'net' | 'pool' | 'qualifying' | 'capacity' | 'resolves';
const SORT_LABEL: Record<SortKey, string> = {
  net: 'est net/day', pool: 'pool/day', qualifying: 'qualifying liq', capacity: 'capacity', resolves: 'resolves soonest',
};
const SORT_TITLE: Record<SortKey, string> = {
  net:        'adverse-adjusted estimate, $1k — the honest primary (gated on free tier)',
  pool:       'the real program reward pool $/day (gated on free tier)',
  qualifying: 'existing qualifying maker liquidity — your competition (gated on free tier)',
  capacity:   'executable book depth at the reward band, price×size (gated on free tier)',
  resolves:   'hours to resolution — soonest first (public field)',
};
function sortVal(m: NormalizedMarket, k: SortKey, side: TradeSideFilter): number | null {
  if (k === 'pool')       return m.dailyPool ?? null;
  if (k === 'qualifying') return sideQual(m, side);
  if (k === 'capacity')   return sideDepth(m, side);
  if (k === 'resolves')   return m.hoursToResolution ?? null;
  return typicalNet(m, side); // net
}

function Pill({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button onClick={onClick} title={title}
      className={['font-body text-[11px] px-2.5 py-1 rounded-button border whitespace-nowrap transition-colors',
        active ? 'text-mint-deep border-mint-deep/50 bg-mint-tint' : 'text-muted border-line bg-surface hover:text-ink-2'].join(' ')}>
      {children}
    </button>
  );
}
function DCell({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="rounded-lg bg-bg-soft border border-line px-2.5 py-2">
      <p className="font-body text-[9px] uppercase tracking-wide text-muted mb-0.5">{label}</p>
      <p className="font-body text-[12px] text-ink-2 tabular-nums leading-tight">{children}</p>
      {note && <p className="font-body text-[9px] text-muted/80 leading-tight mt-0.5">{note}</p>}
    </div>
  );
}

// ── Expandable reward row ─────────────────────────────────────────────────────
function RewardRow({ m, tradeSide, open, onToggle }: { m: NormalizedMarket; tradeSide: TradeSideFilter; open: boolean; onToggle: () => void }) {
  const est       = fullEst(m, tradeSide);
  const net       = est.netPerDay;
  const revealed  = isRevealed(m);
  const wh        = withheldNote(est);
  const cardMid   = sideMid(m, tradeSide);
  const cardDepth = sideDepth(m, tradeSide);
  const cardQual  = sideQual(m, tradeSide);
  const risk      = (m.newsRisk ?? 'unknown') as NewsRisk;
  const sideLabel = tradeSide === 'both' ? 'two-sided' : `${tradeSide.toUpperCase()} side`;
  const cautionFlag = m.flags.some(f => ['TRAP', 'THIN_CAP', 'SHORT_BURST'].includes(f));
  const platformUrl = rewardMarketUrl(m);
  const dash = <span className="text-muted">—</span>;
  const dashNote = (t: string) => <>{dash}<span className="text-muted"> · {t}</span></>;

  // Headline tone: green if a real positive net; muted when withheld/suppressed/flagged.
  const netTone = net == null ? 'text-muted' : cautionFlag ? 'text-muted' : net > 0 ? 'text-mint-deep' : 'text-coral-ink';

  // Headline value — three honest states:
  //   • revealed + net present → the estimate (muted if flagged)
  //   • revealed + net null    → the honest withheld/suppressed note (never a lock)
  //   • not revealed (free)    → <Redacted> paywall lock
  const headline =
    revealed && net == null
      ? <span className={`font-body ${wh.suppressed ? 'text-gold' : 'text-muted'}`} style={{ fontSize: 13 }}>{wh.text}</span>
      : <span className={`font-display font-bold ${netTone}`} style={{ fontSize: 18 }}>
          <Redacted value={net}>{v => `${fmtUsd(v)}/day`}</Redacted>
        </span>;

  return (
    <div className="border-b border-line">
      {/* Fixed-width net/day column (104px mobile / 150px sm+) so a long withheld note
          wraps INSIDE it and can never crush the title cell. items-start keeps a
          2-line title top-aligned with the value. */}
      <button onClick={onToggle} className="w-full grid grid-cols-[auto_minmax(0,1fr)_104px_auto] sm:grid-cols-[auto_minmax(0,1fr)_150px_auto] items-start gap-2.5 sm:gap-3 px-3 py-2.5 text-left hover:bg-bg-soft/60 transition-colors">
        <span className="w-8 h-8 rounded-[9px] bg-bg-soft border border-line grid place-items-center shrink-0">
          <PlatformLogo platform={m.venue} size={16} />
        </span>
        {/* Title wraps to 2 lines (never truncated to 1-2 chars); LIVE + verify status
            sit on their OWN line below, so the status note can't overlap the title. */}
        <span className="min-w-0">
          <span className="font-body text-[12.5px] font-medium text-ink leading-snug line-clamp-2 break-words">{m.title}</span>
          <span className="flex items-center gap-1.5 flex-wrap mt-1">
            <span className="font-body text-[8.5px] uppercase tracking-wide text-mint-deep border border-mint-deep/30 bg-mint-tint rounded px-1">LIVE</span>
            {cautionFlag && <span className="font-body text-[8.5px] uppercase tracking-wide text-gold border border-gold/40 rounded px-1">flagged</span>}
            <VerifyBadge v={(m as any).__verify} />
          </span>
          <span className="font-body text-[10px] text-muted block mt-0.5 break-words">
            {m.category}
            {` · ${m.twoSidedRequired ? 'two-sided req' : 'one-sided ok'}`}
            {` · resolves ${fmtHours(m.hoursToResolution)}`}
            {risk === 'high' ? ' · news HIGH' : ''}
          </span>
        </span>
        <span className="text-right tabular-nums min-w-0">
          <span className="block font-display leading-tight break-words">{headline}</span>
          <span className="block font-body text-[8.5px] uppercase tracking-wide text-muted mt-0.5">est net/day · $1k {sideLabel} · not guaranteed</span>
        </span>
        <ChevronRight className={`w-3.5 h-3.5 text-muted shrink-0 mt-0.5 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="px-3 pb-3 pt-0.5 bg-bg-soft/40">
          {/* Honest banner for the withheld/suppressed case */}
          {revealed && net == null && (
            <div className={`rounded-lg px-3 py-1.5 mb-1.5 border ${wh.suppressed ? 'bg-gold-tint border-gold/25' : 'bg-bg-soft border-line'}`}>
              <p className={`font-body text-[11px] leading-snug ${wh.suppressed ? 'text-gold' : 'text-muted'}`}>
                {wh.suppressed
                  ? 'Est net/day suppressed — the implied run-rate exceeds the 200%/yr sanity cap or modeled gross exceeds the real book depth. On a thin book your own size would dominate; a number here would overstate. Shown withheld, never fabricated.'
                  : `Est net/day withheld — ${wh.text.replace(/^withheld — /, '')}. Not computed from data we can stand behind (never fabricated).`}
              </p>
            </div>
          )}
          {cautionFlag && net != null && (
            <div className="rounded-lg bg-gold-tint border border-gold/25 px-3 py-1.5 mb-1.5">
              <p className="font-body text-[11px] text-gold leading-snug">Thin-book flag ({m.flags.filter(f => ['TRAP','THIN_CAP','SHORT_BURST'].includes(f)).join(', ').toLowerCase()}) — the estimate is muted, not a green go-signal. Verify book depth before deploying.</p>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            <DCell label="Venue">{m.venue === 'polymarket' ? 'Polymarket' : 'Kalshi'}</DCell>
            <DCell label="Pool / day" note={m.scoringModel?.includes('kalshi') ? 'Kalshi LIP · derived' : 'real program pool'}>
              <Redacted value={m.dailyPool}>{v => `$${(v as number).toFixed(0)}`}</Redacted>
            </DCell>
            <DCell label="Est net/day · $1k" note="current · estimate, not guaranteed">
              {revealed && net == null
                ? <span className={wh.suppressed ? 'text-gold' : 'text-muted'}>{wh.text}</span>
                : <span className={netTone}><Redacted value={net}>{v => `${fmtUsd(v as number)}/day`}</Redacted></span>}
            </DCell>
            <DCell label="Annualized" note={est.annualizedLabel}>
              {est.annualizedPct == null
                ? dash
                : <Redacted value={est.annualizedPct}>{v => `${(v as number).toFixed(0)}%/yr${est.annualizedCapped ? '+' : ''}`}</Redacted>}
            </DCell>
            <DCell label="Forward reward">{dashNote('not projected (not deterministic)')}</DCell>
            <DCell label="Qualifying liq" note={cardQual === 0 ? 'reads 0 — unmeasured, not "no competition"' : 'your competition'}>
              {cardQual === 0 ? dashNote('unmeasured') : <Redacted value={cardQual}>{v => fmtUsd(v as number)}</Redacted>}
            </DCell>
            <DCell label="Capacity" note="executable depth · price×size">
              <Redacted value={cardDepth}>{v => fmtUsd(v as number)}</Redacted>
            </DCell>
            <DCell label="Spread band">
              <Redacted value={m.maxSpread}>{v => `${(v as number).toFixed(1)}¢`}</Redacted>
            </DCell>
            <DCell label="Min size">
              <Redacted value={m.minSize}>{v => `$${(v as number).toFixed(0)}`}</Redacted>
            </DCell>
            <DCell label={`Mid${tradeSide === 'both' ? '' : ` · ${tradeSide.toUpperCase()}`}`}>
              <Redacted value={cardMid}>{v => `${((v as number) * 100).toFixed(1)}¢`}</Redacted>
            </DCell>
            <DCell label="Resolves">{fmtHours(m.hoursToResolution)}</DCell>
            <DCell label="Scoring">{m.scoringModel?.includes('quadratic') ? 'quadratic CLOB' : m.scoringModel?.includes('kalshi') ? 'Kalshi LIP' : (m.scoringModel || '—')}</DCell>
          </div>

          {/* Flags + news + live-book link */}
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
            <NewsBadge risk={risk} />
            {m.flags.filter(f => ['TRAP', 'SHORT_BURST', 'ONE_SIDED', 'THIN_CAP'].includes(f)).map(f => (
              <span key={f} className="inline-flex items-center px-2 py-[3px] rounded-md font-body font-medium text-[10px] border bg-gold-tint text-gold border-gold/25">{f.replace('_', ' ').toLowerCase()}</span>
            ))}
            <span className="ml-auto flex items-center gap-3">
              <Link href={`/dashboard/liquidity-rewards/${encodeURIComponent(m.marketId)}`}
                className="inline-flex items-center gap-1 font-body text-[11px] text-mint-deep hover:text-mint transition-colors">
                Open live order book <ChevronRight size={13} />
              </Link>
              {platformUrl && (
                <PlatformLink href={platformUrl} label={m.venue === 'polymarket' ? 'Polymarket' : 'Kalshi'} compact />
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function LiquidityRewardsPage() {
  const [data, setData]           = useState<UnifiedResponse | null>(null);
  const [err, setErr]             = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  // filter/sort state — initialized from URL, mirrored back (client-side, no history spam)
  const qp0 = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const [sortKey, setSortKey]   = useState<SortKey>((['pool', 'qualifying', 'capacity', 'resolves'].includes(qp0.get('sort') ?? '') ? qp0.get('sort') : 'net') as SortKey);
  const [venueF, setVenueF]     = useState<'' | 'polymarket' | 'kalshi'>((['polymarket', 'kalshi'].includes(qp0.get('venue') ?? '') ? qp0.get('venue') : '') as any);
  const [catF, setCatF]         = useState(qp0.get('cat') ?? '');
  const [tradeSide, setTradeSide] = useState<TradeSideFilter>((['yes', 'no'].includes(qp0.get('side') ?? '') ? qp0.get('side') : 'both') as TradeSideFilter);
  const [qualOnly, setQualOnly] = useState(qp0.get('qual') === '1');
  const [minRate, setMinRate]   = useState(() => { const n = Number(qp0.get('minRate')); return Number.isFinite(n) && n > 0 ? n : 0; });
  const [minPool, setMinPool]   = useState(() => { const n = Number(qp0.get('minPool')); return Number.isFinite(n) && n > 0 ? n : 0; });
  const [resMinH, setResMinH]   = useState<number | null>(() => { const n = Number(qp0.get('res')); return Number.isFinite(n) && n > 0 ? n : null; });
  const [hideNews, setHideNews] = useState(qp0.get('news') === '0');
  const [openId, setOpenId]     = useState<string | null>(null);

  async function poll() {
    try {
      const res = await fetch('/api/rewards-unified', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as UnifiedResponse;
      setData(json); setErr(null); setLastFetch(new Date());
    } catch (e: any) { setErr(e?.message ?? 'fetch error'); }
  }
  useEffect(() => { poll(); const id = setInterval(poll, POLL_MS); return () => clearInterval(id); }, []);

  const markets = data?.markets ?? [];
  const meta    = data?.meta;
  const isStale = data?.stale ?? true;

  // mirror filter state → URL
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams();
    if (sortKey !== 'net') p.set('sort', sortKey);
    if (venueF)  p.set('venue', venueF);
    if (catF)    p.set('cat', catF);
    if (tradeSide !== 'both') p.set('side', tradeSide);
    if (qualOnly) p.set('qual', '1');
    if (minRate > 0) p.set('minRate', String(minRate));
    if (minPool > 0) p.set('minPool', String(minPool));
    if (resMinH) p.set('res', String(resMinH));
    if (hideNews) p.set('news', '0');
    const qs = p.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [sortKey, venueF, catF, tradeSide, qualOnly, minRate, minPool, resMinH, hideNews]);

  const categories = useMemo(
    () => Array.from(new Set(markets.map(m => m.category))).filter(Boolean).sort(),
    [markets],
  );

  const filtered = useMemo(() => {
    const out = markets.filter(m => {
      if (venueF && m.venue !== venueF) return false;
      if (catF && m.category !== catF) return false;
      if (qualOnly && !((sideQual(m, tradeSide) ?? 0) > 0)) return false;         // real competition data only
      if (minPool > 0 && m.dailyPool != null && m.dailyPool < minPool) return false;
      if (resMinH != null && (m.hoursToResolution == null || m.hoursToResolution < resMinH)) return false;
      if (hideNews && m.newsRisk === 'high') return false;
      // Min rate is a gated field → it only EXCLUDES visible (paid) rows; a free-tier
      // user can never be filtered out by data they can't see (honest).
      if (minRate > 0) { const n = typicalNet(m, tradeSide); if (n != null && n < minRate) return false; }
      return true;
    });
    return out.slice().sort((a, b) => {
      const asc = sortKey === 'resolves';
      const av = sortVal(a, sortKey, tradeSide), bv = sortVal(b, sortKey, tradeSide);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return asc ? av - bv : bv - av;
    });
  }, [markets, venueF, catF, qualOnly, minPool, resMinH, hideNews, minRate, sortKey, tradeSide]);

  // Hero: best est net/day (Redacted-gated) + counts from public meta.
  const bestNet = useMemo(() => {
    const nets = markets.map(m => typicalNet(m, tradeSide)).filter((v): v is number => v != null);
    return nets.length ? Math.max(...nets) : null;
  }, [markets, tradeSide]);
  const qualifyingCount = useMemo(() => markets.filter(m => (sideQual(m, tradeSide) ?? 0) > 0).length, [markets, tradeSide]);
  const highNews = markets.filter(m => m.newsRisk === 'high').length;

  const filtersActive = !!(venueF || catF || tradeSide !== 'both' || qualOnly || minRate || minPool || resMinH || hideNews);
  const resetFilters = () => { setVenueF(''); setCatF(''); setTradeSide('both'); setQualOnly(false); setMinRate(0); setMinPool(0); setResMinH(null); setHideNews(false); };

  return (
    <div className="min-h-screen" style={{ background: 'radial-gradient(circle at 50% -10%, rgba(15,190,130,.05), transparent 60%), #F5F8F6' }}>
      <div className="dash-container px-4 py-6 sm:py-8 space-y-6">

        <RewardsHero />

        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow className="mb-1">Liquidity Rewards</Eyebrow>
            <SectionHeading as="h1" className="text-xl sm:text-2xl flex items-center gap-3 flex-wrap">
              <PlatformLogo platform="polymarket" size={20} /><PlatformLogo platform="kalshi" size={20} />
              Get paid to post limit orders
            </SectionHeading>
            <p className="font-body text-sm text-muted mt-1">
              Real reward pools from Polymarket &amp; Kalshi. <b className="text-ink-2">Est net/day</b> subtracts the expected adverse-fill cost — a forward estimate, never a locked return. Filter, sort, tap a row for the honest breakdown.
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <LiveBadge live={!!(meta && !isStale)} />
            <span className="font-body text-[12px] text-muted">
              {lastFetch ? `fetched ${ago(lastFetch.toISOString())}` : '—'}{meta ? ` · data ${ago(meta.generatedAt)}` : ''}
            </span>
          </div>
        </div>

        {isStale && meta && (
          <div className="px-4 py-3 rounded-card border border-gold/25 bg-gold-tint font-body text-sm text-gold">
            Data is stale (last scan {ago(meta.generatedAt)}). The scanners run every 15 min — check back shortly.
          </div>
        )}
        {err && !data && (
          <div className="px-4 py-3 rounded-card border border-coral-ink/25 bg-coral-tint font-body text-sm text-coral-ink">{err}</div>
        )}

        <Explainer />

        {/* Hero stats — only data-backed elements */}
        {meta && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Reward markets" value={String(meta.totalMarkets)} note={`${meta.polymarket} Polymarket · ${meta.kalshi} Kalshi`} />
            <StatCard label="Real pools" value={String(meta.withRealPool)} demoted={meta.poolUnknown > 0 ? `${meta.poolUnknown} pool unknown` : 'all pools known'} />
            <StatCard
              label="Best est net/day · $1k"
              value={<Redacted value={bestNet}>{v => `${fmtUsd(v as number)}/day`}</Redacted>}
              demoted="estimate, not guaranteed"
            />
            <StatCard label="Qualifying pools" value={String(qualifyingCount)} note="measured competition" demoted={highNews > 0 ? `${highNews} high news-risk` : 'live exec OFF'} />
          </div>
        )}

        {/* Sort pills */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-body text-[10px] uppercase tracking-wide text-muted">Sort</span>
          {(Object.keys(SORT_LABEL) as SortKey[]).map(k => (
            <button key={k} onClick={() => setSortKey(k)} title={SORT_TITLE[k]}
              className={['font-body text-[11px] uppercase tracking-wide pb-0.5 border-b-2 transition-colors', sortKey === k ? 'text-ink border-[#0c9d6e]' : 'text-muted border-transparent hover:text-ink-2'].join(' ')}>
              {SORT_LABEL[k]}
            </button>
          ))}
        </div>

        {/* Venue + trade-side pills */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Pill active={!venueF} onClick={() => setVenueF('')}>All venues</Pill>
          <Pill active={venueF === 'polymarket'} onClick={() => setVenueF(venueF === 'polymarket' ? '' : 'polymarket')}>Polymarket</Pill>
          <Pill active={venueF === 'kalshi'} onClick={() => setVenueF(venueF === 'kalshi' ? '' : 'kalshi')}>Kalshi</Pill>
          <span className="h-3.5 w-px bg-line shrink-0" aria-hidden />
          {([['both', 'Both'], ['yes', 'Trade YES'], ['no', 'Trade NO']] as [TradeSideFilter, string][]).map(([v, label]) => (
            <Pill key={v} active={tradeSide === v} onClick={() => setTradeSide(v)}
              title="Each binary side has its own book (YES + NO ≈ 100¢). Ranks/estimates every row from that side's real book.">{label}</Pill>
          ))}
          <span className="h-3.5 w-px bg-line shrink-0" aria-hidden />
          <Pill active={qualOnly} onClick={() => setQualOnly(v => !v)} title="Only markets with measured qualifying liquidity (real competition data)">qualifying only</Pill>
          <label className="flex items-center gap-1.5 cursor-pointer ml-1" title="Hide markets where a news/volatility spike makes a resting quote most likely to get picked off">
            <input type="checkbox" checked={hideNews} onChange={e => setHideNews(e.target.checked)} className="w-3.5 h-3.5 accent-coral-ink" />
            <span className="font-body text-[11px] text-muted">hide high news-risk</span>
          </label>
        </div>

        {/* Category pills */}
        {categories.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <Pill active={!catF} onClick={() => setCatF('')}>All categories</Pill>
            {categories.map(c => <Pill key={c} active={catF === c} onClick={() => setCatF(catF === c ? '' : c)}>{c}</Pill>)}
          </div>
        )}

        {/* Range inputs + reset */}
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 whitespace-nowrap" title="Min est net/day $1k (gated field — filters visible/paid rows only)">
            <span className="font-body text-[10px] uppercase tracking-wide text-muted">Net/day ≥</span>
            <span className="font-body text-[10px] text-muted">$</span>
            <input type="number" inputMode="decimal" min={0} step={0.5} value={minRate === 0 ? '' : minRate} placeholder="0"
              onChange={e => { const n = Number(e.target.value); setMinRate(Number.isFinite(n) && n > 0 ? n : 0); }}
              className="w-16 px-1.5 py-0.5 rounded-button border border-line bg-surface text-ink font-mono text-[11px] tabular-nums text-right focus:outline-none focus:border-mint-deep/50" />
          </label>
          <label className="flex items-center gap-1.5 whitespace-nowrap" title="Min real reward pool $/day (gated field — filters visible/paid rows only)">
            <span className="font-body text-[10px] uppercase tracking-wide text-muted">Pool ≥</span>
            <span className="font-body text-[10px] text-muted">$</span>
            <input type="number" inputMode="decimal" min={0} step={10} value={minPool === 0 ? '' : minPool} placeholder="0"
              onChange={e => { const n = Number(e.target.value); setMinPool(Number.isFinite(n) && n > 0 ? n : 0); }}
              className="w-16 px-1.5 py-0.5 rounded-button border border-line bg-surface text-ink font-mono text-[11px] tabular-nums text-right focus:outline-none focus:border-mint-deep/50" />
          </label>
          <span className="h-3.5 w-px bg-line shrink-0" aria-hidden />
          <span className="font-body text-[10px] uppercase tracking-wide text-muted">Resolves in ≥</span>
          {[[24, '24h'], [72, '3d'], [168, '7d'], [720, '30d']].map(([h, lbl]) => (
            <Pill key={h} active={resMinH === h} onClick={() => setResMinH(resMinH === h ? null : (h as number))} title={`At least ${lbl} to resolution`}>{lbl as string}+</Pill>
          ))}
          {filtersActive && <button onClick={resetFilters} className="font-body text-[10px] uppercase tracking-wide text-muted hover:text-coral-ink transition-colors">Reset</button>}
          <span className="ml-auto font-body text-[10px] text-muted tabular-nums">{filtered.length} of {markets.length}</span>
        </div>

        {/* Column header */}
        <div className="grid grid-cols-[auto_minmax(0,1fr)_104px_auto] sm:grid-cols-[auto_minmax(0,1fr)_150px_auto] gap-2.5 sm:gap-3 px-3 pt-1 pb-1.5 text-[9px] uppercase tracking-wider text-muted border-b border-line">
          <span className="w-8" aria-hidden />
          <span>Market</span>
          <span className="text-right">Est net/day · $1k</span>
          <span className="w-3.5" aria-hidden />
        </div>

        {/* Rows */}
        <div className="-mt-4 rounded-b-lg overflow-hidden bg-surface border-x border-b border-line shadow-card">
          {data === null ? (
            <p className="font-body text-[12px] text-muted text-center py-10">Loading reward markets…</p>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10">
              <p className="font-body text-sm text-muted">No markets match these filters.</p>
              {markets.length > 0 && <button onClick={resetFilters} className="font-body text-[12px] text-mint-deep underline mt-2">reset filters</button>}
            </div>
          ) : (
            filtered.map(m => (
              <RewardRow key={m.marketId} m={m} tradeSide={tradeSide} open={openId === m.marketId} onToggle={() => setOpenId(openId === m.marketId ? null : m.marketId)} />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="pt-2 border-t border-line space-y-1">
          <p className="font-body text-[11px] text-muted/60 leading-relaxed">
            Estimates only, from live order-book depth (executable prices, never midpoint for fills). Net subtracts expected adverse-fill cost and is <b>capped/withheld</b> when the run-rate exceeds the 200%/yr sanity cap or modeled gross exceeds real book depth — never a fabricated figure.
            Polymarket uses its quadratic CLOB scoring; Kalshi&apos;s LIP formula is not public — its share is an observed flat pro-rata inference. Not financial advice.
          </p>
          <p className="font-body text-[11px] text-muted/60">Read-only. No orders placed. Live execution OFF. No login required.</p>
        </div>
      </div>
    </div>
  );
}

function LiveBadge({ live }: { live: boolean }) {
  return live ? (
    <span className="flex items-center gap-1.5 font-body font-medium text-xs text-mint-deep border border-mint-deep/30 bg-mint-tint px-2.5 py-1 rounded-pill">
      <span className="w-1.5 h-1.5 rounded-full bg-mint" aria-hidden /> LIVE
    </span>
  ) : (
    <span className="font-body font-medium text-xs text-gold border border-gold/30 bg-gold-tint px-2.5 py-1 rounded-pill">STALE</span>
  );
}
