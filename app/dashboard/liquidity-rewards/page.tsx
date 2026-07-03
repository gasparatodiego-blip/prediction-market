'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import Eyebrow from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import StatCard from '@/app/components/ui/StatCard';
import BlipRow from '@/app/components/ui/BlipRow';
import EdgeChip, { type EdgeChipVariant } from '@/app/components/ui/EdgeChip';
import PlatformLogo from '@/components/PlatformLogo';
import { kIsWarn, isSaneKalshiMarket, isSanePolymarketLevel } from '@/lib/reward-gating';
import { Redacted } from '@/app/components/ui/Redacted';

// ── Types · Polymarket ─────────────────────────────────────────────────────────

type VolRisk  = 'LOW' | 'MEDIUM' | 'HIGH';
type GapClass = 'OPEN' | 'TRAP' | 'none';
type Capital  = 500 | 5000 | 50000;
type SortMode = 'default' | 'gap';

// share/grossRewardDay/dayYieldPct/rewardsDailyRate/etc: null on free tier
// (server-side redaction, lib/paid-gating.ts) — teaser fields (question,
// dates, flags, min size... wait rewardsMinSize IS sensitive, see below) stay real.
interface LevelData {
  capital:         number;
  share:           number | null;
  grossRewardDay:  number | null;
  dayYieldPct:     number | null;
  netRewardDay?:   number | null;
  netYieldPct?:    number | null;
  shareHigh?:      number | null;
  grossHigh?:      number | null;
  netHigh?:        number | null;
  shareLow?:       number | null;
  grossLow?:       number | null;
  netLow?:         number | null;
  thinBookFlag:    boolean;
  belowFloorFlag:  boolean;
  flags:           string[];
}

interface Market {
  question:          string;
  conditionId:       string;
  rewardsDailyRate:  number | null;
  rewardsMaxSpread:  number | null;
  rewardsMinSize:    number | null;
  existing_depth_usd: number | null;
  volatilityRisk:    VolRisk;
  volatilityStdev:   number | null;
  endDate:           string | null;
  negRisk:           boolean;
  mid:               number | null;
  bookSpread:        number | null;
  sane500:           boolean;
  levels:            Record<string, LevelData>;
  gapClass:          GapClass;
  gapScore:          number;
}

interface Meta {
  generatedAt:   string;
  totalMarkets:  number;
  saneAt500:     number;
  flaggedAt500:  number;
  capitalLevels: number[];
  disclaimer:    string;
}

interface ApiResponse {
  meta:    Meta | null;
  markets: Market[];
  stale:   boolean;
  error?:  string;
}

// ── Types · Kalshi ─────────────────────────────────────────────────────────────

interface KLevelData {
  aboveMin:       boolean;
  share:          number | null;
  bidShare:       number | null;
  askShare:       number | null;
  grossRewardDay: number | null;
  dayYieldPct:    number | null;
  netRewardDay?:  number | null;
  netYieldPct?:   number | null;
}

interface KMarket {
  ticker:                     string;
  question:                   string;
  pool_day:                   number | null;
  total_period_usd:           number | null;
  period_days:                number;
  period_start:               string;
  period_end:                 string;
  min_size:                   number;
  fee_discount_pct:           number;
  last_price:                 number | null;
  book_mid:                   number | null;
  best_bid:                   number | null;
  best_ask:                   number | null;
  competitor_qualifying_bids: number | null;
  competitor_qualifying_asks: number | null;
  levels:                     Record<string, KLevelData>;
  flags: {
    TRAP:        boolean;
    SHORT_BURST: boolean;
    BELOW_FLOOR: boolean;
    THIN_CAP:    boolean;
    ONE_SIDED:   boolean;
  };
  trap_reason:   string | null;
  scoring_model: string;
  timestamp:     string;
}

interface KMeta {
  source:         string;
  total_programs: number;
  processed:      number;
  timestamp:      string;
  scoring_model:  string;
  disclaimer:     string;
}

interface KData {
  _meta:   KMeta | null;
  markets: KMarket[];
  stale:   boolean;
  error?:  string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CAPITAL_OPTIONS: Capital[] = [500, 5000, 50000];
const CAPITAL_LABELS: Record<Capital, string> = { 500: '$500', 5000: '$5k', 50000: '$50k' };
const POLL_MS = 5 * 60_000;

const VOL_ORDER: Record<VolRisk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

// ── Shared helpers ─────────────────────────────────────────────────────────────

function ago(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function fmtDepth(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n}`;
}

function fmtReward(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 10)   return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

function daysLeft(endDate: string | null): number | null {
  if (!endDate) return null;
  return (new Date(endDate).getTime() - Date.now()) / 86_400_000;
}

// ── Polymarket sort ────────────────────────────────────────────────────────────

function defaultCmp(capital: Capital) {
  const key = String(capital);
  return (a: Market, b: Market): number => {
    const la = a.levels[key];
    const lb = b.levels[key];
    if (!la || !lb) return 0;
    const aFlagged = la.flags.length > 0 ? 1 : 0;
    const bFlagged = lb.flags.length > 0 ? 1 : 0;
    if (aFlagged !== bFlagged) return aFlagged - bFlagged;
    const vA = VOL_ORDER[a.volatilityRisk] ?? 2;
    const vB = VOL_ORDER[b.volatilityRisk] ?? 2;
    if (vA !== vB) return vA - vB;
    return (lb.grossRewardDay ?? 0) - (la.grossRewardDay ?? 0);
  };
}

function sortMarkets(markets: Market[], capital: Capital, mode: SortMode): Market[] {
  if (mode === 'gap') {
    const opens = markets.filter(m => m.gapClass === 'OPEN').sort((a, b) => b.gapScore - a.gapScore);
    const rest  = markets.filter(m => m.gapClass !== 'OPEN').sort(defaultCmp(capital));
    return [...opens, ...rest];
  }
  return [...markets].sort(defaultCmp(capital));
}

const prefetchedBooks = new Set<string>();

function prefetchBook(conditionId: string) {
  if (prefetchedBooks.has(conditionId)) return;
  prefetchedBooks.add(conditionId);
  fetch(`/api/liquidity-rewards/book?conditionId=${encodeURIComponent(conditionId)}`, {
    cache: 'no-store',
    priority: 'low',
  } as RequestInit).catch(() => {/* fire-and-forget */});
}

// ── Kalshi helpers ─────────────────────────────────────────────────────────────

function kDepthUsd(shares: number | null, price: number | null, mid: number | null): number | null {
  if (shares == null) return null;
  return shares * (price ?? mid ?? 0);
}

function kFmtD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  if (n >= 10)        return `$${n.toFixed(0)}`;
  return `$${n.toFixed(1)}`;
}

function kSortMarkets(markets: KMarket[], capital: Capital): KMarket[] {
  const key = String(capital);
  return [...markets].sort((a, b) => {
    if (a.flags.TRAP !== b.flags.TRAP) return a.flags.TRAP ? 1 : -1;
    const aW = kIsWarn(a), bW = kIsWarn(b);
    if (aW !== bW) return aW ? 1 : -1;
    const aF = a.flags.SHORT_BURST || a.flags.BELOW_FLOOR || a.flags.THIN_CAP || a.flags.ONE_SIDED || !(a.levels[key]?.aboveMin);
    const bF = b.flags.SHORT_BURST || b.flags.BELOW_FLOOR || b.flags.THIN_CAP || b.flags.ONE_SIDED || !(b.levels[key]?.aboveMin);
    if (aF !== bF) return aF ? 1 : -1;
    return (b.levels[key]?.grossRewardDay ?? 0) - (a.levels[key]?.grossRewardDay ?? 0);
  });
}

// ── Platform toggle ────────────────────────────────────────────────────────────

function PlatformToggle({
  platform,
  onChange,
}: {
  platform: 'polymarket' | 'kalshi';
  onChange: (p: 'polymarket' | 'kalshi') => void;
}) {
  return (
    <div className="flex items-center gap-1 p-1 rounded-pill bg-bg-soft border border-line w-fit">
      {(['polymarket', 'kalshi'] as const).map(p => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`inline-flex items-center gap-1.5 font-body font-medium text-[13px] px-4 py-1.5 rounded-pill transition-colors duration-100
            ${platform === p
              ? 'bg-surface shadow-sm text-ink'
              : 'text-muted hover:text-ink-2'}`}
        >
          <PlatformLogo platform={p} size={14} />
          {p === 'polymarket' ? 'Polymarket' : 'Kalshi'}
        </button>
      ))}
    </div>
  );
}

// ── Polymarket flag + gap badges ───────────────────────────────────────────────

function FlagBadge({ text }: { text: string }) {
  const isThin  = text.includes('THIN BOOK');
  const isFloor = text.includes('payout floor');
  const cls = isThin
    ? 'bg-gold-tint text-gold border-gold/25'
    : isFloor
      ? 'bg-bg-soft text-muted border-line'
      : 'bg-gold-tint text-gold border-gold/25';
  return (
    <span className={`inline-flex items-center px-2 py-[2px] rounded-md font-body font-medium text-[10px] border ${cls}`}>
      {isThin ? 'THIN BOOK' : isFloor ? 'BELOW FLOOR' : text.split('—')[0].trim()}
    </span>
  );
}

function GapBadge({ gapClass }: { gapClass: GapClass }) {
  if (gapClass === 'OPEN') {
    return (
      <span
        title="Thinly-covered reward band — low competition entry window."
        className="inline-flex items-center px-2 py-[2px] rounded-md font-body font-medium text-[10px] border bg-mint-tint text-mint-deep border-mint-deep/20"
      >
        OPEN BAND
      </span>
    );
  }
  if (gapClass === 'TRAP') {
    return (
      <span
        title="Band is uncovered because adverse-fill risk deters makers — high volatility."
        className="inline-flex items-center px-2 py-[2px] rounded-md font-body font-medium text-[10px] border bg-gold-tint text-gold border-gold/25"
      >
        GAP · ADVERSE RISK
      </span>
    );
  }
  return null;
}

// ── Polymarket chip variant ────────────────────────────────────────────────────

function pmChipVariant(lv: LevelData): EdgeChipVariant {
  if (lv.thinBookFlag) return 'speculative';
  if (lv.flags.length > 0) return 'speculative';
  return 'signal';
}

// ── Detail chip (shared small info pill) ──────────────────────────────────────

function DetailChip({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 font-body text-[11px] px-2.5 py-1 rounded-md bg-bg-soft border border-line">
      <span className="text-muted">{label}</span>
      <span className="text-ink-2 font-medium">{value}</span>
    </div>
  );
}

// ── Polymarket market card ─────────────────────────────────────────────────────

function MarketCard({
  market,
  capital,
  rank,
}: {
  market:  Market;
  capital: Capital;
  rank:    number;
}) {
  const lv = market.levels[String(capital)];
  if (!lv) return null;

  const isFlagged  = !isSanePolymarketLevel(lv);
  const chip       = pmChipVariant(lv);
  const tileColor: 'mint' | 'violet' | 'gold' =
    market.volatilityRisk === 'LOW' ? 'mint' : 'gold';
  const days       = daysLeft(market.endDate);
  const netOrGross = lv.netRewardDay ?? lv.grossRewardDay;
  const shareLowHigh = lv.shareLow != null && lv.shareHigh != null ? [lv.shareLow, lv.shareHigh] as const : null;
  const netLowHigh   = (lv.netLow ?? lv.grossLow) != null && (lv.netHigh ?? lv.grossHigh) != null
    ? [lv.netLow ?? lv.grossLow!, lv.netHigh ?? lv.grossHigh!] as const : null;
  const yieldPct   = lv.netYieldPct ?? lv.dayYieldPct;

  const volIcon =
    market.volatilityRisk === 'LOW' ? '◎'
    : market.volatilityRisk === 'HIGH' ? '△'
    : '◈';

  return (
    <Link
      href={`/dashboard/liquidity-rewards/${encodeURIComponent(market.conditionId)}`}
      prefetch={true}
      onMouseEnter={() => prefetchBook(market.conditionId)}
      className="block"
    >
      <div className={`rounded-card shadow-card bg-surface overflow-hidden hover:shadow-lg transition-shadow ${isFlagged ? 'opacity-80' : ''}`}>

        <BlipRow
          icon={volIcon}
          tileColor={tileColor}
          name={market.question.length > 72 ? market.question.slice(0, 69) + '…' : market.question}
          sub={
            <>
              #{rank} · ±<Redacted value={market.rewardsMaxSpread}>{v => `${v}`}</Redacted>¢ band · {market.volatilityRisk.toLowerCase()} vol · mid{' '}
              <Redacted value={market.mid}>{v => v.toFixed(3)}</Redacted>
              {days != null && days > 0 && days < 30 ? ` · ${Math.floor(days)}d left` : ''}
            </>
          }
          chip={chip}
          value={<Redacted value={netOrGross}>{v => fmtReward(v)}</Redacted>}
          unit={<>/day · est. net · <Redacted value={lv.share}>{v => `${(v * 100).toFixed(2)}%`}</Redacted> share</>}
          valueTone={isFlagged ? 'neutral' : 'up'}
        />

        {/* Detail strip */}
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          <DetailChip label="pool/day" value={<Redacted value={market.rewardsDailyRate}>{v => `$${v.toFixed(0)}`}</Redacted>} />
          <DetailChip label="depth" value={<Redacted value={market.existing_depth_usd}>{v => fmtDepth(v)}</Redacted>} />
          <DetailChip label="min sz" value={<Redacted value={market.rewardsMinSize}>{v => String(v)}</Redacted>} />
          {shareLowHigh && (
            <DetailChip
              label="share range"
              value={`${(shareLowHigh[0] * 100).toFixed(2)}–${(shareLowHigh[1] * 100).toFixed(2)}%`}
            />
          )}
          {netLowHigh && (
            <DetailChip
              label="net range"
              value={`${fmtReward(netLowHigh[0])}–${fmtReward(netLowHigh[1])}`}
            />
          )}
          <DetailChip
            label="est. %/day"
            value={<Redacted value={yieldPct}>{v => `${v.toFixed(2)}%`}</Redacted>}
          />
          {lv.flags.map((f, i) => <FlagBadge key={i} text={f} />)}
          <GapBadge gapClass={market.gapClass ?? 'none'} />
          {market.negRisk && (
            <span className="inline-flex items-center px-2 py-[2px] rounded-md font-body font-medium text-[10px] border bg-bg-soft text-muted border-line">
              negRisk
            </span>
          )}
        </div>

        <p className="px-4 pb-3 font-body text-[10px] text-muted/60 leading-relaxed">
          Inv. risk not subtracted · estimate only · not financial advice
        </p>
      </div>
    </Link>
  );
}

// ── Kalshi observed-model chip ─────────────────────────────────────────────────

const OBSERVED_MODEL_FULL =
  "Kalshi hasn't published its LIP scoring formula. This is an inferred flat " +
  "pro-rata model, not official. Kalshi LIP competition is currently thin, so " +
  "yields read higher than Polymarket and will compress as makers enter. Estimate only.";

function ObservedModelChip() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center">
      <button
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill border border-gold/40 bg-gold-tint text-gold font-body font-medium text-[10px] hover:border-gold/60 transition-colors"
        aria-expanded={open}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-gold flex-shrink-0" aria-hidden />
        OBSERVED MODEL · estimate
        <span className="text-gold/60 ml-0.5">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <span className="absolute top-full left-0 z-20 mt-1.5 w-80 rounded-card border border-line bg-surface shadow-card px-4 py-3">
          <p className="font-body text-[12px] text-muted leading-relaxed">{OBSERVED_MODEL_FULL}</p>
          <button
            onClick={() => setOpen(false)}
            className="font-body text-[11px] text-muted/60 hover:text-muted mt-2"
          >
            close ✕
          </button>
        </span>
      )}
    </span>
  );
}

// ── Kalshi flag badge ──────────────────────────────────────────────────────────

function KBadge({ label, color }: { label: string; color: 'red' | 'amber' | 'orange' | 'zinc' }) {
  const cls: Record<string, string> = {
    red:    'bg-coral-tint text-coral-ink border-coral-ink/20',
    amber:  'bg-gold-tint text-gold border-gold/25',
    orange: 'bg-gold-tint text-gold border-gold/25',
    zinc:   'bg-bg-soft text-muted border-line',
  };
  return (
    <span className={`inline-flex items-center px-2 py-[2px] rounded-md font-body font-medium text-[10px] border ${cls[color]}`}>
      {label}
    </span>
  );
}

// ── Kalshi chip variant ────────────────────────────────────────────────────────

function kChipVariant(m: KMarket, capital: Capital): EdgeChipVariant {
  if (m.flags.TRAP) return 'trap';
  if (kIsWarn(m) || m.flags.SHORT_BURST || m.flags.THIN_CAP || m.flags.ONE_SIDED || m.flags.BELOW_FLOOR) return 'speculative';
  if (!(m.levels[String(capital)]?.aboveMin)) return 'speculative';
  return 'signal';
}

// ── Kalshi market row ──────────────────────────────────────────────────────────

function KMarketRow({
  market,
  capital,
  rank,
}: {
  market:  KMarket;
  capital: Capital;
  rank:    number;
}) {
  const key = String(capital);
  const lv  = market.levels[key];

  const isTrap     = market.flags.TRAP;
  const isWarn     = kIsWarn(market);
  const isBurst    = market.flags.SHORT_BURST;
  const isThinCap  = market.flags.THIN_CAP;
  const isFloor    = market.flags.BELOW_FLOOR;
  const isOneSided = market.flags.ONE_SIDED;
  const isBelowMin = !lv?.aboveMin;

  const anyFlag    = isTrap || isWarn || isBurst || isThinCap || isFloor || isOneSided || isBelowMin;
  const chip       = kChipVariant(market, capital);
  const tileColor: 'mint' | 'violet' | 'gold' = isTrap ? 'gold' : anyFlag ? 'gold' : 'mint';

  const mid      = market.book_mid ?? market.last_price;
  const bidDepth = kDepthUsd(market.competitor_qualifying_bids, market.best_bid,  mid);
  const askDepth = kDepthUsd(market.competitor_qualifying_asks, market.best_ask, mid);
  const netOrGross = lv?.netRewardDay ?? lv?.grossRewardDay ?? null;
  const yieldPct   = lv?.netYieldPct  ?? lv?.dayYieldPct    ?? null;

  const hoursLeft = (new Date(market.period_end).getTime() - Date.now()) / 3_600_000;

  return (
    <Link
      href={`/dashboard/liquidity-rewards/kalshi/${encodeURIComponent(market.ticker)}`}
      className="block"
    >
      <div className={`rounded-card shadow-card bg-surface overflow-hidden hover:shadow-lg transition-shadow ${isTrap ? 'opacity-50' : anyFlag ? 'opacity-80' : ''}`}>

        <BlipRow
          icon="◎"
          tileColor={tileColor}
          name={market.question.length > 72 ? market.question.slice(0, 69) + '…' : market.question}
          sub={
            <>
              #{rank} · <Redacted value={mid}>{v => v.toFixed(3)}</Redacted> mid · {market.fee_discount_pct}% fee disc
              {hoursLeft > 0 && hoursLeft < 24 ? ` · ${hoursLeft.toFixed(1)}h left` : ''}
            </>
          }
          chip={chip}
          value={lv && lv.aboveMin ? <Redacted value={netOrGross}>{v => fmtReward(v)}</Redacted> : '—'}
          unit={lv && lv.aboveMin
            ? <>/day · est. net · <Redacted value={lv.share}>{v => `${(v * 100).toFixed(2)}%`}</Redacted> share</>
            : `below min at ${CAPITAL_LABELS[capital]}`}
          valueTone={anyFlag ? 'neutral' : 'up'}
        />

        {/* Trap / warn inline notes */}
        {isTrap && market.trap_reason && (
          <p className="px-4 pt-0 pb-2 font-body text-[11px] text-coral-ink leading-relaxed">
            {market.trap_reason}
          </p>
        )}
        {isWarn && (
          <p className="px-4 pt-0 pb-2 font-body text-[11px] text-gold leading-relaxed">
            Lopsided price — adverse fill risk elevated
          </p>
        )}

        {/* Detail strip */}
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          <DetailChip label="pool/day" value={<Redacted value={market.pool_day}>{v => `$${v.toFixed(0)}`}</Redacted>} />
          {isBurst ? (
            <>
              <DetailChip label="total" value={<Redacted value={market.total_period_usd}>{v => `$${v.toFixed(0)}`}</Redacted>} />
              <DetailChip label="period" value={`${(market.period_days * 24).toFixed(0)}h burst`} />
            </>
          ) : (
            <DetailChip label="period" value={`${market.period_days.toFixed(1)}d`} />
          )}
          <DetailChip label="bid depth" value={<Redacted value={bidDepth}>{v => kFmtD(v)}</Redacted>} />
          <DetailChip label="ask depth" value={<Redacted value={askDepth}>{v => kFmtD(v)}</Redacted>} />
          {lv && lv.aboveMin && (
            <DetailChip label="est. %/day" value={<Redacted value={yieldPct}>{v => `${v.toFixed(2)}%`}</Redacted>} />
          )}
          <DetailChip label="min sz" value={market.min_size.toLocaleString()} />

          {isTrap     && <KBadge label="TRAP"            color="red"    />}
          {isWarn     && <KBadge label="WARN · lopsided" color="amber"  />}
          {isBurst    && <KBadge label="SHORT BURST"     color="orange" />}
          {isThinCap  && <KBadge label="THIN / CAP"      color="orange" />}
          {isFloor    && <KBadge label="BELOW FLOOR"     color="zinc"   />}
          {isOneSided && <KBadge label="ONE-SIDED"       color="zinc"   />}
          {isBelowMin && !isTrap && (
            <KBadge label={`< ${CAPITAL_LABELS[capital]} min`} color="zinc" />
          )}
        </div>

        <p className="px-4 pb-3 font-body text-[10px] text-muted/60">
          Observed model · inv. risk not subtracted · estimate only
        </p>
      </div>
    </Link>
  );
}

// ── Live / stale badge ─────────────────────────────────────────────────────────

function LiveBadge({ live }: { live: boolean }) {
  if (live) {
    return (
      <span className="flex items-center gap-1.5 font-body font-medium text-xs text-mint-deep border border-mint-deep/30 bg-mint-tint px-2.5 py-1 rounded-pill">
        <span className="w-1.5 h-1.5 rounded-full bg-mint flex-shrink-0" aria-hidden />
        LIVE
      </span>
    );
  }
  return (
    <span className="font-body font-medium text-xs text-gold border border-gold/30 bg-gold-tint px-2.5 py-1 rounded-pill">
      STALE
    </span>
  );
}

// ── Capital selector (shared) ──────────────────────────────────────────────────

function CapitalSelector({
  capital,
  onChange,
  note,
}: {
  capital:  Capital;
  onChange: (c: Capital) => void;
  note?:    string;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="font-body text-[11px] uppercase tracking-wide text-muted mr-1">Capital:</span>
      {CAPITAL_OPTIONS.map(c => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={`font-body font-medium text-sm px-3 py-1.5 rounded-button border transition-colors duration-100
            ${capital === c
              ? 'border-mint-deep/40 bg-mint-tint text-mint-deep'
              : 'border-line bg-surface text-muted hover:border-mint-deep/30 hover:text-ink-2'}`}
        >
          {CAPITAL_LABELS[c]}
        </button>
      ))}
      {note && <span className="font-body text-[11px] text-muted ml-2">{note}</span>}
    </div>
  );
}

// ── KalshiView ─────────────────────────────────────────────────────────────────

function KalshiView() {
  const [data,       setData]       = useState<KData | null>(null);
  const [capital,    setCapital]    = useState<Capital>(500);
  const [howToOpen,  setHowToOpen]  = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [retryNote,  setRetryNote]  = useState<string | null>(null);
  const [lastFetch,  setLastFetch]  = useState<Date | null>(null);
  const hasLoadedRef = useRef(false);

  async function poll() {
    try {
      const res = await fetch('/api/kalshi-rewards', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as KData;
      setData(json);
      setFetchError(null);
      setRetryNote(null);
      setLastFetch(new Date());
      hasLoadedRef.current = true;
    } catch (e: any) {
      const msg = e.message ?? 'fetch error';
      if (hasLoadedRef.current) {
        setRetryNote(msg);
      } else {
        setFetchError(msg);
      }
    }
  }

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const markets   = data?.markets ?? [];
  const meta      = data?._meta;
  const isStale   = data?.stale ?? true;
  const sorted    = kSortMarkets(markets, capital);
  const key       = String(capital);

  const saneCount = sorted.filter(m => isSaneKalshiMarket(m, key)).length;

  const trapCount  = markets.filter(m => m.flags.TRAP).length;
  // null (not 0) when every market's pool_day is redacted — never silently
  // undercounts a real total by summing nulls as zero.
  const poolVals   = markets.map(m => m.pool_day).filter((v): v is number => v != null);
  const totalPool  = markets.length > 0 && poolVals.length === 0 ? null : poolVals.reduce((s, v) => s + v, 0);

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow className="mb-1">Liquidity Rewards</Eyebrow>
          <SectionHeading as="h1" className="text-2xl flex items-center gap-3 flex-wrap">
            <PlatformLogo platform="kalshi" size={20} />
            Kalshi LIP Rewards
            <ObservedModelChip />
          </SectionHeading>
          <p className="font-body text-sm text-muted mt-1">
            Kalshi Liquidity Incentive Program — makers earn rewards for resting qualifying orders.
            Real pools, flat pro-rata share estimate.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <LiveBadge live={!!(meta && !isStale)} />
          <span className="font-body text-[12px] text-muted">
            {lastFetch ? `fetched ${ago(lastFetch.toISOString())}` : '—'}
            {meta ? ` · data ${ago(meta.timestamp)}` : ''}
          </span>
        </div>
      </div>

      {/* Banners */}
      {isStale && meta && (
        <div className="px-4 py-3 rounded-card border border-gold/25 bg-gold-tint font-body text-sm text-gold">
          Data is stale (last scan: {ago(meta.timestamp)}). Scanner may be offline — check back shortly.
        </div>
      )}
      {fetchError && !data && (
        <div className="px-4 py-3 rounded-card border border-coral-ink/25 bg-coral-tint font-body text-sm text-coral-ink">
          {fetchError}
        </div>
      )}
      {retryNote && data && (
        <div className="px-4 py-3 rounded-card border border-line bg-surface font-body text-sm text-muted">
          ↻ retrying… ({retryNote}){lastFetch ? ` · data ${ago(lastFetch.toISOString())}` : ''}
        </div>
      )}
      {!data && !fetchError && (
        <div className="px-4 py-3 rounded-card border border-line bg-surface font-body text-sm text-muted">
          Loading — or run agent25-kalshi-rewards to generate data/kalshi-rewards.json.
        </div>
      )}

      {/* How to read */}
      <div className="rounded-card shadow-card bg-surface overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-5 py-4 text-left"
          onClick={() => setHowToOpen(v => !v)}
        >
          <span className="font-body font-medium text-sm text-ink-2">How to read these numbers (Kalshi)</span>
          <span className="font-body text-[11px] text-muted">{howToOpen ? '▲ close' : '▼ expand'}</span>
        </button>
        {howToOpen && (
          <div className="px-5 pb-5 space-y-3 border-t border-line">
            <ul className="mt-4 space-y-2.5">
              {([
                ['Pool $/day (real)',    'Dollar amount Kalshi allocates to LIP makers per day. From the Kalshi API — not an estimate.'],
                ['Period',              'Program duration. SHORT BURST programs last < 1 day — the $/day number is extrapolated. Check the period total reward instead.'],
                ['Min size (shares)',   'Minimum qualifying order size in shares. Kalshi has not published exact qualifying rules.'],
                ['Bid / ask depth ≈USD','Competitor qualifying depth per side, converted from shares to approximate USD at current mid. Your capital competes against this.'],
                ['Est. share',          "Flat pro-rata per side: your_shares / (your_shares + competitor_shares), min(bid, ask). OBSERVED MODEL — not Kalshi's official formula (not public)."],
                ['Est. net/day',        'share × pool/day. NET OF PLATFORM FEES — Kalshi LIP rewards are paid from the incentive pool separately from trading fees. Does not subtract inventory/adverse-selection risk from fills. Yields look high because competition is thin now; they will compress as makers enter.'],
                ['%/day',              'net reward / capital. >5%/day (THIN/CAP) means the book is very thin and yield will compress rapidly.'],
                ['TRAP',               'last_price > 0.90 or < 0.10: near-certain outcome, one side nearly empty. Adverse fill risk is extreme. Pushed to bottom.'],
                ['WARN · lopsided',    'last_price 0.80–0.90 or 0.10–0.20: lopsided book, elevated adverse fill risk. Shown but de-emphasised.'],
                ['SHORT BURST',        'Period < 1 day. The daily rate is extrapolated from a very short window — the total period reward is the grounding number.'],
                ['THIN/CAP',           '>5%/day yield at this capital: book is very thin, share will compress as competitors arrive.'],
              ] as [string, string][]).map(([term, def]) => (
                <li key={term} className="font-body text-[12px] text-muted leading-relaxed pl-3 border-l-2 border-line">
                  <span className="text-ink-2 font-medium">{term}:</span>{' '}{def}
                </li>
              ))}
            </ul>
            <p className="font-body text-[11px] text-muted/60 pt-1">
              No "profit", "guaranteed", or "signal" implied. Estimates only. Not financial advice.
            </p>
          </div>
        )}
      </div>

      {/* Capital selector */}
      <CapitalSelector
        capital={capital}
        onChange={setCapital}
        note="per-side · two-sided posting"
      />

      {/* Summary stat cards */}
      {meta && markets.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label="Programs scanned"
            value={String(meta.processed)}
          />
          <StatCard
            label={`Clean at ${CAPITAL_LABELS[capital]}`}
            value={String(saneCount)}
            note="no trap / warn / flag"
          />
          <StatCard
            label="Total pool / day"
            value={<Redacted value={totalPool}>{v => `$${Math.round(v).toLocaleString()}`}</Redacted>}
            demoted="real pool — est. share not included"
          />
          <StatCard
            label="Trap markets"
            value={String(trapCount)}
            note="adverse fill risk"
            demoted="pushed to bottom of list"
          />
        </div>
      )}

      {/* Market table label */}
      {sorted.length > 0 && (
        <div>
          <p className="font-body text-[11px] uppercase tracking-wide text-muted mb-3">
            Reward markets — sane first · TRAP/WARN/flagged last · {CAPITAL_LABELS[capital]} capital · flat pro-rata observed model
          </p>
          <div className="space-y-2">
            {sorted.map((m, i) => (
              <KMarketRow key={m.ticker} market={m} capital={capital} rank={i + 1} />
            ))}
          </div>
        </div>
      )}

      {markets.length === 0 && data && !data.error && (
        <div className="rounded-card shadow-card bg-surface px-5 py-10 text-center">
          <p className="font-body text-sm text-muted">No reward-eligible markets found in this scan.</p>
        </div>
      )}

      {/* Footer */}
      <div className="pt-4 border-t border-line space-y-1">
        <p className="font-body text-[11px] text-muted/60 leading-relaxed">
          {meta?.disclaimer ?? 'ESTIMATE ONLY · Kalshi LIP scoring formula not public · behavioral inference · not financial advice'}
        </p>
        <p className="font-body text-[11px] text-muted/60">
          Read-only. No orders placed. No login required. Source: Kalshi Trade API v2.
        </p>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function LiquidityRewardsPage() {
  const [platform,    setPlatform]    = useState<'polymarket' | 'kalshi'>('polymarket');
  const [data,        setData]        = useState<ApiResponse | null>(null);
  const [capital,     setCapital]     = useState<Capital>(500);
  const [sortMode,    setSortMode]    = useState<SortMode>('default');
  const [howToOpen,   setHowToOpen]   = useState(false);
  const [fetchError,  setFetchError]  = useState<string | null>(null);
  const [lastFetch,   setLastFetch]   = useState<Date | null>(null);

  async function poll() {
    try {
      const res = await fetch('/api/liquidity-rewards', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as ApiResponse;
      setData(json);
      setFetchError(null);
      setLastFetch(new Date());
    } catch (e: any) {
      setFetchError(e.message ?? 'fetch error');
    }
  }

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const markets  = data?.markets ?? [];
  const meta     = data?.meta;
  const isStale  = data?.stale ?? true;

  const sorted    = sortMarkets(markets, capital, sortMode);
  const openCount = markets.filter(m => m.gapClass === 'OPEN').length;
  const levelKey  = String(capital);
  const saneCount = sorted.filter(m => m.levels[levelKey]?.flags.length === 0).length;
  // null (not 0) when every market's rewardsDailyRate is redacted.
  const poolVals  = markets.map(m => m.rewardsDailyRate).filter((v): v is number => v != null);
  const totalPool = markets.length > 0 && poolVals.length === 0 ? null : poolVals.reduce((s, v) => s + v, 0);

  return (
    <div
      className="min-h-screen"
      style={{ background: 'radial-gradient(circle at 50% -10%, rgba(15,190,130,.05), transparent 60%), #F5F8F6' }}
    >
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">

        {/* Platform toggle */}
        <div className="flex items-center gap-4 flex-wrap">
          <PlatformToggle platform={platform} onChange={setPlatform} />
          <span className="font-body text-[12px] text-muted">
            {platform === 'polymarket'
              ? 'Polymarket CLOB · read-only · typical placement estimate · no orders placed'
              : 'Kalshi LIP · read-only · observed model · no orders placed'}
          </span>
        </div>

        {/* ── Polymarket view ── */}
        {platform === 'polymarket' && (
          <div className="space-y-6">

            {/* Header */}
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <Eyebrow className="mb-1">Liquidity Rewards</Eyebrow>
                <SectionHeading as="h1" className="text-2xl flex items-center gap-3">
                  <PlatformLogo platform="polymarket" size={20} />
                  Polymarket CLOB Rewards
                </SectionHeading>
                <p className="font-body text-sm text-muted mt-1">
                  Polymarket pays makers who rest limit orders near the mid — filled or not.
                  Real pools, your measured share.
                </p>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <LiveBadge live={!!(meta && !isStale)} />
                <span className="font-body text-[12px] text-muted">
                  {lastFetch ? `fetched ${ago(lastFetch.toISOString())}` : '—'}
                  {meta ? ` · data ${ago(meta.generatedAt)}` : ''}
                </span>
              </div>
            </div>

            {/* Banners */}
            {isStale && meta && (
              <div className="px-4 py-3 rounded-card border border-gold/25 bg-gold-tint font-body text-sm text-gold">
                Data is stale (last scan: {ago(meta.generatedAt)}). Agent may be restarting or scanning — check back shortly.
              </div>
            )}
            {fetchError && (
              <div className="px-4 py-3 rounded-card border border-coral-ink/25 bg-coral-tint font-body text-sm text-coral-ink">
                {fetchError}
              </div>
            )}

            {/* How to read */}
            <div className="rounded-card shadow-card bg-surface overflow-hidden">
              <button
                className="w-full flex items-center justify-between px-5 py-4 text-left"
                onClick={() => setHowToOpen(v => !v)}
              >
                <span className="font-body font-medium text-sm text-ink-2">How to read these numbers</span>
                <span className="font-body text-[11px] text-muted">{howToOpen ? '▲ close' : '▼ expand'}</span>
              </button>
              {howToOpen && (
                <div className="px-5 pb-5 space-y-3 border-t border-line">
                  <ul className="mt-4 space-y-2.5">
                    {([
                      ['Pool $/day (real)', 'The dollar amount Polymarket allocates to reward makers on this market per day. This is the actual program rate — not an estimate.'],
                      ['Existing depth', 'Dollar notional (price × size) of all qualifying resting orders currently in the CLOB within the reward band. This is your competition. It changes continuously.'],
                      ['Typ. est. share', "Estimated pool fraction using Polymarket's quadratic formula S(v,s)=((v-s)/v)². TYPICAL placement: both sides posted at s=v/2 (half the half-band, S=0.25) — a realistic farming position. Range shows outer-band low (s=0.8v, S=0.04) to near-mid high (s=0.1¢). Actual share depends on exact resting price and competitor re-quoting. Share compresses as makers enter."],
                      ['Est. net/day', 'share × pool $/day. NET OF PLATFORM FEES — Polymarket CLOB maker fee is 0%; reward is paid from the pool in USDC with no fee deducted; Polygon gas ≈ $0. Does NOT subtract inventory/adverse-selection risk from fills — that is non-deterministic and rises with volatility.'],
                      ['THIN BOOK flag', 'Gross yield >5%/day at this capital: the book is very thin and your share will compress as other makers arrive.'],
                      ['BELOW FLOOR flag', 'Gross reward <$1/day at this capital: Polymarket pays out in whole dollars; this position likely earns nothing.'],
                      ['Adverse risk class', 'LOW = slow-moving market, far from resolution. HIGH = near expiry or high recent volatility. HIGH-risk markets are likely to see informed flow picking off your orders.'],
                      ['OPEN BAND badge', 'Thinly-covered reward band at $500 capital (≥20% estimated share) with a meaningful pool and LOW or MEDIUM adverse-fill risk. This marks where there is room to enter — not a promised return. The window fills quickly as other makers arrive and share compresses. All figures are estimates.'],
                      ['GAP · ADVERSE RISK badge', 'Band is thinly covered — but precisely because HIGH volatility deters other makers from resting orders. Not a free opportunity: informed flow is likely to pick off your resting orders at a loss that exceeds the reward income.'],
                    ] as [string, string][]).map(([term, def]) => (
                      <li key={term} className="font-body text-[12px] text-muted leading-relaxed pl-3 border-l-2 border-line">
                        <span className="text-ink-2 font-medium">{term}:</span>{' '}{def}
                      </li>
                    ))}
                  </ul>
                  <p className="font-body text-[11px] text-muted/60 pt-1">
                    No "profit", "guaranteed", or "signal" implied. These are estimates for educational and research purposes only.
                  </p>
                </div>
              )}
            </div>

            {/* Capital selector */}
            <CapitalSelector
              capital={capital}
              onChange={setCapital}
              note="per-side estimate — two-sided posting assumed"
            />

            {/* Summary stat cards */}
            {meta && markets.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Markets scanned" value={String(meta.totalMarkets)} />
                <StatCard
                  label={`Clean at ${CAPITAL_LABELS[capital]}`}
                  value={String(saneCount)}
                  note="no THIN BOOK / BELOW FLOOR flags"
                />
                <StatCard
                  label="Total pool / day"
                  value={<Redacted value={totalPool}>{v => `$${Math.round(v).toLocaleString()}`}</Redacted>}
                  demoted="real pool — est. share not included"
                />
                <div
                  className={`rounded-card shadow-card bg-surface px-5 py-5 ${openCount > 0 ? 'cursor-pointer border border-mint-deep/20 hover:border-mint-deep/40 transition-colors' : ''}`}
                  onClick={() => openCount > 0 && setSortMode(m => m === 'gap' ? 'default' : 'gap')}
                  title={openCount > 0 ? 'Toggle: surface open-band markets to the top' : 'No open bands at this scan'}
                >
                  <p className="font-body text-[11px] uppercase tracking-wide text-muted mb-2">Open band gaps</p>
                  <p className="font-display font-bold text-ink leading-none tracking-tight" style={{ fontSize: 33 }}>
                    {openCount}
                  </p>
                  {openCount > 0 ? (
                    <p className="font-body text-sm text-ink-2 mt-2 leading-snug">
                      {sortMode === 'gap' ? '▲ surfaced to top' : 'tap to surface'}
                    </p>
                  ) : (
                    <p className="font-body text-[11px] text-muted mt-1.5 leading-snug">no gaps this scan</p>
                  )}
                </div>
              </div>
            )}

            {/* Market list */}
            {sorted.length > 0 ? (
              <div>
                <div className="flex items-center gap-3 flex-wrap mb-3">
                  <p className="font-body text-[11px] uppercase tracking-wide text-muted">
                    {sortMode === 'gap'
                      ? 'Open-band gaps first — est. share ≥ 20% at $500, LOW/MED risk'
                      : 'Reward markets — LOW adverse-risk sane first, flagged last'}
                  </p>
                  <span className="font-body text-[11px] text-muted/60">
                    {CAPITAL_LABELS[capital]} capital · depth snapshot every 15 min
                  </span>
                  <button
                    onClick={() => setSortMode(m => m === 'gap' ? 'default' : 'gap')}
                    className={`ml-auto font-body font-medium text-[11px] px-3 py-1.5 rounded-button border transition-colors
                      ${sortMode === 'gap'
                        ? 'border-mint-deep/40 bg-mint-tint text-mint-deep'
                        : 'border-line bg-surface text-muted hover:text-ink-2'}`}
                  >
                    {sortMode === 'gap' ? '▲ open bands first' : 'show open-band gaps first'}
                  </button>
                </div>

                {sortMode === 'gap' && openCount === 0 && (
                  <div className="mb-3 px-4 py-3 rounded-card border border-line bg-surface font-body text-[12px] text-muted">
                    No open band gaps detected in this scan — all reward bands are adequately covered at the 20% share threshold.
                    Check back after the next 15-min depth snapshot.
                  </div>
                )}

                <div className="space-y-2">
                  {sorted.map((m, i) => (
                    <MarketCard key={m.conditionId} market={m} capital={capital} rank={i + 1} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-card shadow-card bg-surface px-5 py-10 text-center space-y-2">
                <p className="font-body text-sm text-muted">
                  {data === null
                    ? 'Loading reward data…'
                    : isStale
                      ? 'Agent is scanning — data will appear once the first cycle completes (~3 min).'
                      : 'No reward-eligible markets found in this scan.'}
                </p>
                <p className="font-body text-[12px] text-muted/60">
                  First scan runs ~10 s after agent start. Refreshes every 15 min.
                </p>
              </div>
            )}

            {/* Disclaimer footer */}
            <div className="pt-4 border-t border-line space-y-1">
              <p className="font-body text-[11px] text-muted/60 leading-relaxed">
                {meta?.disclaimer ?? 'Estimates only. Adverse-fill risk not subtracted. Not financial advice.'}
              </p>
              <p className="font-body text-[11px] text-muted/60">
                Read-only. No orders placed. No login required.
              </p>
            </div>
          </div>
        )}

        {/* ── Kalshi view ── */}
        {platform === 'kalshi' && <KalshiView />}

      </div>
    </div>
  );
}
