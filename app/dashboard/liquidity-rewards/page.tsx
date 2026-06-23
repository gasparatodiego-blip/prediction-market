'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

// ── Types · Polymarket ─────────────────────────────────────────────────────────

type VolRisk  = 'LOW' | 'MEDIUM' | 'HIGH';
type GapClass = 'OPEN' | 'TRAP' | 'none';
type Capital  = 500 | 5000 | 50000;
type SortMode = 'default' | 'gap';

interface LevelData {
  capital:         number;
  share:           number;
  grossRewardDay:  number;
  dayYieldPct:     number;
  shareHigh?:      number;
  grossHigh?:      number;
  shareLow?:       number;
  grossLow?:       number;
  thinBookFlag:    boolean;
  belowFloorFlag:  boolean;
  flags:           string[];
}

interface Market {
  question:          string;
  conditionId:       string;
  rewardsDailyRate:  number;
  rewardsMaxSpread:  number;
  rewardsMinSize:    number;
  existing_depth_usd: number;
  volatilityRisk:    VolRisk;
  volatilityStdev:   number | null;
  endDate:           string | null;
  negRisk:           boolean;
  mid:               number;
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
  share:          number;
  bidShare:       number;
  askShare:       number;
  grossRewardDay: number;
  dayYieldPct:    number;
}

interface KMarket {
  ticker:                     string;
  question:                   string;
  pool_day:                   number;
  total_period_usd:           number;
  period_days:                number;
  period_start:               string;
  period_end:                 string;
  min_size:                   number;
  fee_discount_pct:           number;
  last_price:                 number;
  book_mid:                   number | null;
  best_bid:                   number | null;
  best_ask:                   number | null;
  competitor_qualifying_bids: number;
  competitor_qualifying_asks: number;
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

const VOL_CLS: Record<VolRisk, string> = {
  LOW:    'text-emerald-400 border-emerald-700/40 bg-emerald-950/20',
  MEDIUM: 'text-amber-400   border-amber-600/40   bg-amber-950/20',
  HIGH:   'text-red-400     border-red-700/40     bg-red-950/20',
};

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

// ── Platform toggle ────────────────────────────────────────────────────────────

function PlatformToggle({
  platform,
  onChange,
}: {
  platform: 'polymarket' | 'kalshi';
  onChange: (p: 'polymarket' | 'kalshi') => void;
}) {
  return (
    <div className="flex items-center gap-0 border border-zinc-700/50 bg-zinc-900/50 p-1 w-fit">
      {(['polymarket', 'kalshi'] as const).map(p => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`font-mono text-[11px] uppercase tracking-widest px-4 py-1.5 transition-colors duration-100
            ${platform === p
              ? 'bg-accent/15 border border-accent/40 text-accent'
              : 'text-zinc-500 hover:text-zinc-300 border border-transparent'}`}
        >
          {p === 'polymarket' ? 'Polymarket' : 'Kalshi'}
        </button>
      ))}
    </div>
  );
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
    return lb.grossRewardDay - la.grossRewardDay;
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

// ── Polymarket sub-components ──────────────────────────────────────────────────

function FlagBadge({ text }: { text: string }) {
  const isThin  = text.includes('THIN BOOK');
  const isFloor = text.includes('payout floor');
  const cls = isThin
    ? 'border-orange-600/50 bg-orange-950/30 text-orange-400'
    : isFloor
      ? 'border-zinc-600/50 bg-zinc-900/50 text-zinc-500'
      : 'border-yellow-600/50 bg-yellow-950/30 text-yellow-400';
  return (
    <span className={`inline-block px-1.5 py-px border text-[9px] font-mono uppercase tracking-wide ${cls}`}>
      {isThin ? 'THIN BOOK' : isFloor ? 'BELOW FLOOR' : text.split('—')[0].trim()}
    </span>
  );
}

function GapBadge({ gapClass }: { gapClass: GapClass }) {
  if (gapClass === 'OPEN') {
    return (
      <span
        title="Thinly-covered reward band — low competition entry window."
        className="inline-block px-1.5 py-px border border-emerald-600/60 bg-emerald-950/40 text-emerald-400 text-[9px] font-mono uppercase tracking-wide"
      >
        OPEN BAND
      </span>
    );
  }
  if (gapClass === 'TRAP') {
    return (
      <span
        title="Band is uncovered because adverse-fill risk deters makers — high volatility."
        className="inline-block px-1.5 py-px border border-amber-600/50 bg-amber-950/30 text-amber-400 text-[9px] font-mono uppercase tracking-wide"
      >
        GAP · ADVERSE RISK
      </span>
    );
  }
  return null;
}

function MarketCard({
  market,
  capital,
  rank,
}: {
  market:  Market;
  capital: Capital;
  rank:    number;
}) {
  const lv     = market.levels[String(capital)];
  if (!lv) return null;

  const volCls    = VOL_CLS[market.volatilityRisk] ?? VOL_CLS.HIGH;
  const isFlagged = lv.flags.length > 0;
  const days      = daysLeft(market.endDate);
  const shareStr  = `${(lv.share * 100).toFixed(2)}%`;

  return (
    <Link
      href={`/dashboard/liquidity-rewards/${encodeURIComponent(market.conditionId)}`}
      prefetch={true}
      onMouseEnter={() => prefetchBook(market.conditionId)}
      className={`border-t py-3 grid grid-cols-12 gap-2 items-start text-xs font-mono
        hover:bg-zinc-800/30 transition-colors cursor-pointer
        ${isFlagged ? 'border-zinc-800/60 opacity-75' : 'border-zinc-800'}`}
    >
      <div className="col-span-1 text-zinc-600 pt-0.5 tabular-nums">#{rank}</div>

      <div className="col-span-5 min-w-0">
        <p className={`leading-snug line-clamp-2 ${isFlagged ? 'text-zinc-500' : 'text-zinc-200'}`}>
          {market.question}
        </p>
        <div className="flex flex-wrap gap-1 mt-1.5">
          <span className={`px-1 py-px border text-[9px] uppercase ${volCls}`}>
            {market.volatilityRisk} risk
          </span>
          {market.negRisk && (
            <span className="px-1 py-px border border-zinc-700 bg-zinc-800 text-zinc-600 text-[9px] uppercase">
              negRisk
            </span>
          )}
          <span className="px-1 py-px border border-zinc-700 bg-zinc-800 text-zinc-600 text-[9px] uppercase">
            mid {market.mid.toFixed(3)}
          </span>
          <span className="px-1 py-px border border-zinc-700 bg-zinc-800 text-zinc-600 text-[9px] uppercase">
            ±{market.rewardsMaxSpread}¢ band
          </span>
          {days !== null && days > 0 && days < 30 && (
            <span className={`px-1 py-px border text-[9px] uppercase ${days < 7 ? 'border-red-700/40 text-red-500' : 'border-zinc-700 bg-zinc-800 text-zinc-600'}`}>
              {Math.floor(days)}d left
            </span>
          )}
          {lv.flags.map((f, i) => <FlagBadge key={i} text={f} />)}
          <GapBadge gapClass={market.gapClass ?? 'none'} />
        </div>
      </div>

      <div className="col-span-2 space-y-0.5">
        <div className="text-zinc-200 tabular-nums">${market.rewardsDailyRate.toFixed(0)}</div>
        <div className="text-zinc-600 text-[10px]">pool/day (real)</div>
        <div className="text-zinc-500 tabular-nums">{fmtDepth(market.existing_depth_usd)}</div>
        <div className="text-zinc-600 text-[10px]">existing depth</div>
      </div>

      <div className="col-span-2 space-y-0.5">
        <div className="text-zinc-300 tabular-nums">{shareStr}</div>
        <div className="text-zinc-600 text-[10px]">typ. est. share</div>
        {lv.shareLow != null && lv.shareHigh != null && (
          <div className="text-zinc-700 text-[9px] tabular-nums">
            {(lv.shareLow * 100).toFixed(2)}–{(lv.shareHigh * 100).toFixed(2)}% range
          </div>
        )}
        <div className="text-zinc-600 text-[10px]">min {market.rewardsMinSize} size</div>
      </div>

      <div className="col-span-2 space-y-0.5">
        <div className={`tabular-nums font-semibold ${isFlagged ? 'text-zinc-500' : 'text-emerald-400'}`}>
          {fmtReward(lv.grossRewardDay)}
        </div>
        <div className="text-zinc-600 text-[10px]">typ. gross/day</div>
        {lv.grossLow != null && lv.grossHigh != null && (
          <div className="text-zinc-700 text-[9px] tabular-nums">
            {fmtReward(lv.grossLow)}–{fmtReward(lv.grossHigh)} range
          </div>
        )}
        <div className="text-zinc-500 tabular-nums text-[10px]">{lv.dayYieldPct.toFixed(2)}%/day yield</div>
        <div className="text-zinc-700 text-[9px]">adverse risk not sub.</div>
      </div>
    </Link>
  );
}

// ── Kalshi helpers ─────────────────────────────────────────────────────────────

function kIsWarn(m: KMarket): boolean {
  if (m.flags.TRAP) return false;
  const p = m.last_price;
  return (p >= 0.80 && p <= 0.90) || (p >= 0.10 && p <= 0.20);
}

function kDepthUsd(shares: number, price: number | null, mid: number | null): number {
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

// ── Kalshi components ──────────────────────────────────────────────────────────

function KBadge({ label, color }: { label: string; color: 'red' | 'amber' | 'orange' | 'zinc' }) {
  const cls = {
    red:    'border-red-700/50 bg-red-950/30 text-red-400',
    amber:  'border-amber-600/50 bg-amber-950/30 text-amber-400',
    orange: 'border-orange-600/50 bg-orange-950/30 text-orange-400',
    zinc:   'border-zinc-600/50 bg-zinc-900/50 text-zinc-500',
  }[color];
  return (
    <span className={`inline-block px-1.5 py-px border text-[9px] font-mono uppercase tracking-wide ${cls}`}>
      {label}
    </span>
  );
}

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

  const anyFlag = isTrap || isWarn || isBurst || isThinCap || isFloor || isOneSided || isBelowMin;

  const mid      = market.book_mid ?? market.last_price;
  const bidDepth = kDepthUsd(market.competitor_qualifying_bids, market.best_bid,  mid);
  const askDepth = kDepthUsd(market.competitor_qualifying_asks, market.best_ask, mid);

  const hoursLeft = (new Date(market.period_end).getTime() - Date.now()) / 3_600_000;

  return (
    <Link
      href={`/dashboard/liquidity-rewards/kalshi/${encodeURIComponent(market.ticker)}`}
      className={`border-t py-3 grid grid-cols-12 gap-2 items-start text-xs font-mono
        hover:bg-zinc-800/20 transition-colors cursor-pointer
        ${isTrap   ? 'border-zinc-800/40 opacity-40'
        : anyFlag  ? 'border-zinc-800/60 opacity-75'
                   : 'border-zinc-800'}`}
    >
      {/* Rank */}
      <div className="col-span-1 text-zinc-600 pt-0.5 tabular-nums">#{rank}</div>

      {/* Question + badges */}
      <div className="col-span-5 min-w-0">
        <p className={`leading-snug line-clamp-2
          ${isTrap ? 'text-zinc-600' : anyFlag ? 'text-zinc-500' : 'text-zinc-200'}`}>
          {market.question}
        </p>
        <div className="flex flex-wrap gap-1 mt-1.5">
          <span className="px-1 py-px border border-zinc-700 bg-zinc-800 text-zinc-600 text-[9px] uppercase">
            {mid.toFixed(3)} mid
          </span>
          <span className="px-1 py-px border border-zinc-700 bg-zinc-800 text-zinc-600 text-[9px] uppercase">
            {market.fee_discount_pct}% fee disc
          </span>
          {hoursLeft > 0 && hoursLeft < 24 && (
            <span className="px-1 py-px border border-orange-700/40 text-orange-400 text-[9px] uppercase">
              {hoursLeft.toFixed(1)}h left
            </span>
          )}
          {isTrap     && <KBadge label="TRAP"            color="red"    />}
          {isWarn     && <KBadge label="WARN · lopsided" color="amber"  />}
          {isBurst    && <KBadge label="SHORT BURST"     color="orange" />}
          {isThinCap  && <KBadge label="THIN/CAP"        color="orange" />}
          {isFloor    && <KBadge label="BELOW FLOOR"     color="zinc"   />}
          {isOneSided && <KBadge label="ONE-SIDED"       color="zinc"   />}
          {isBelowMin && !isTrap && (
            <KBadge label={`< ${CAPITAL_LABELS[capital]} min`} color="zinc" />
          )}
        </div>
        {isTrap && market.trap_reason && (
          <p className="text-[9px] text-red-900 mt-0.5 truncate">{market.trap_reason}</p>
        )}
        {isWarn && (
          <p className="text-[9px] text-amber-900 mt-0.5">lopsided price — adverse fill risk elevated</p>
        )}
      </div>

      {/* Pool + period */}
      <div className="col-span-2 space-y-0.5">
        <div className="text-zinc-200 tabular-nums">${market.pool_day.toFixed(0)}</div>
        <div className="text-zinc-600 text-[10px]">pool/day (real)</div>
        {isBurst ? (
          <>
            <div className="text-orange-400/80 tabular-nums">${market.total_period_usd.toFixed(0)} total</div>
            <div className="text-zinc-600 text-[10px]">for {(market.period_days * 24).toFixed(0)}h burst</div>
          </>
        ) : (
          <div className="text-zinc-500 tabular-nums text-[10px]">{market.period_days.toFixed(1)}d period</div>
        )}
        <div className="text-zinc-600 text-[10px]">min {market.min_size.toLocaleString()} shares</div>
      </div>

      {/* Depth bid/ask */}
      <div className="col-span-2 space-y-0.5">
        <div className="text-zinc-400 tabular-nums">{kFmtD(bidDepth)}</div>
        <div className="text-zinc-600 text-[10px]">bid depth ≈USD</div>
        <div className="text-zinc-400 tabular-nums">{kFmtD(askDepth)}</div>
        <div className="text-zinc-600 text-[10px]">ask depth ≈USD</div>
      </div>

      {/* Share + gross */}
      <div className="col-span-2 space-y-0.5">
        {lv && lv.aboveMin ? (
          <>
            <div className="text-zinc-300 tabular-nums">{(lv.share * 100).toFixed(2)}%</div>
            <div className="text-zinc-600 text-[10px]">est. share</div>
            <div className={`tabular-nums font-semibold
              ${isTrap ? 'text-zinc-600' : anyFlag ? 'text-zinc-500' : 'text-emerald-400'}`}>
              {fmtReward(lv.grossRewardDay)}
            </div>
            <div className="text-zinc-600 text-[10px]">est. gross/day</div>
            <div className="text-zinc-500 tabular-nums text-[10px]">{lv.dayYieldPct.toFixed(2)}%/day</div>
            <div className="text-zinc-700 text-[9px]">obs. model only</div>
          </>
        ) : (
          <div className="text-zinc-700 text-[10px]">below min at this capital</div>
        )}
      </div>
    </Link>
  );
}

// ── Kalshi observed-model chip (compact, expandable) ──────────────────────────

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
        className="inline-flex items-center gap-1 px-2 py-0.5 border border-amber-600/50
          bg-amber-950/30 text-amber-400 font-mono text-[9px] uppercase tracking-wide
          hover:bg-amber-950/50 transition-colors"
        aria-expanded={open}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400/70 shrink-0" />
        OBSERVED MODEL · estimate
        <span className="text-amber-600 ml-0.5">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <span
          className="absolute top-full left-0 z-20 mt-1.5 w-72 border border-amber-600/40
            bg-zinc-900 shadow-lg px-3 py-2.5"
        >
          <p className="font-mono text-[10px] text-amber-300/80 leading-relaxed">
            {OBSERVED_MODEL_FULL}
          </p>
          <button
            onClick={() => setOpen(false)}
            className="font-mono text-[9px] text-zinc-600 hover:text-zinc-400 mt-1.5"
          >
            close ✕
          </button>
        </span>
      )}
    </span>
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

  const saneCount = sorted.filter(m =>
    !m.flags.TRAP && !kIsWarn(m) &&
    !m.flags.SHORT_BURST && !m.flags.THIN_CAP && !m.flags.BELOW_FLOOR && !m.flags.ONE_SIDED &&
    m.levels[key]?.aboveMin,
  ).length;

  const trapCount = markets.filter(m => m.flags.TRAP).length;
  const totalPool = markets.reduce((s, m) => s + m.pool_day, 0);

  return (
    <div className="space-y-7">

      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="font-mono text-xl font-bold text-zinc-100 tracking-tight">
          KALSHI LIP REWARDS
        </h1>
        <ObservedModelChip />
        {meta && !isStale ? (
          <span className="flex items-center gap-1.5 font-mono text-xs text-emerald-400 border border-emerald-600/40 bg-emerald-950/30 px-2 py-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
        ) : (
          <span className="font-mono text-xs text-orange-400 border border-orange-500/40 px-2 py-0.5">STALE</span>
        )}
        <span className="font-mono text-[10px] text-zinc-600 ml-auto">
          {lastFetch ? `fetched ${ago(lastFetch.toISOString())}` : '—'}
          {meta ? ` · data ${ago(meta.timestamp)}` : ''}
        </span>
      </div>

      <p className="font-mono text-sm text-zinc-400 leading-relaxed">
        Kalshi Liquidity Incentive Program — makers earn rewards for resting qualifying orders.{' '}
        <span className="text-zinc-300">Real pools, flat pro-rata share estimate.</span>
      </p>

      {isStale && meta && (
        <div className="border border-orange-600/40 bg-orange-950/15 px-4 py-3 font-mono text-xs text-orange-400">
          Data is stale (last scan: {ago(meta.timestamp)}). Scanner may be offline — check back shortly.
        </div>
      )}

      {fetchError && !data && (
        <div className="font-mono text-xs text-red-400 border border-red-800 bg-red-950/20 px-3 py-2">
          {fetchError}
        </div>
      )}

      {retryNote && data && (
        <div className="font-mono text-xs text-zinc-500 border border-zinc-800 bg-zinc-900/50 px-3 py-2">
          ↻ retrying… ({retryNote}){lastFetch ? ` · data ${ago(lastFetch.toISOString())}` : ''}
        </div>
      )}

      {!data && !fetchError && (
        <div className="border border-zinc-800 bg-zinc-900/50 px-4 py-3 font-mono text-xs text-zinc-500">
          Loading — or run agent25-kalshi-rewards to generate data/kalshi-rewards.json.
        </div>
      )}

      {/* How to read */}
      <div className="border border-zinc-700/50 bg-zinc-900/40">
        <button
          className="w-full flex items-center justify-between px-4 py-3 text-left"
          onClick={() => setHowToOpen(v => !v)}
        >
          <span className="font-mono text-[10px] text-zinc-400 uppercase tracking-widest">
            How to read these numbers (Kalshi)
          </span>
          <span className="font-mono text-[10px] text-zinc-600">{howToOpen ? '▲ close' : '▼ expand'}</span>
        </button>
        {howToOpen && (
          <div className="px-4 pb-4 space-y-2 border-t border-zinc-800">
            <ul className="mt-3 space-y-2">
              {([
                ['Pool $/day (real)',    'Dollar amount Kalshi allocates to LIP makers per day. From the Kalshi API — not an estimate.'],
                ['Period',              'Program duration. SHORT BURST programs last < 1 day — the $/day number is extrapolated. Check the period total reward instead.'],
                ['Min size (shares)',   'Minimum qualifying order size in shares. Kalshi has not published exact qualifying rules.'],
                ['Bid / ask depth ≈USD','Competitor qualifying depth per side, converted from shares to approximate USD at current mid. Your capital competes against this.'],
                ['Est. share',          'Flat pro-rata per side: your_shares / (your_shares + competitor_shares), min(bid, ask). OBSERVED MODEL — not Kalshi\'s official formula (not public).'],
                ['Est. gross/day',      'share × pool/day. Gross only — adverse fill risk is not subtracted. Yields look high because competition is thin now; they will compress as makers enter.'],
                ['%/day',              'gross / capital. >5%/day (THIN/CAP) means the book is very thin and yield will compress rapidly.'],
                ['TRAP',               'last_price > 0.90 or < 0.10: near-certain outcome, one side nearly empty. Adverse fill risk is extreme. Pushed to bottom.'],
                ['WARN · lopsided',    'last_price 0.80–0.90 or 0.10–0.20: lopsided book, elevated adverse fill risk. Shown but de-emphasised.'],
                ['SHORT BURST',        'Period < 1 day. The daily rate is extrapolated from a very short window — the total period reward is the grounding number.'],
                ['THIN/CAP',           '>5%/day yield at this capital: book is very thin, share will compress as competitors arrive.'],
              ] as [string, string][]).map(([term, def]) => (
                <li key={term} className="font-mono text-[11px] text-zinc-500 leading-relaxed pl-3 border-l border-zinc-700/40">
                  <span className="text-zinc-400">{term}:</span> {def}
                </li>
              ))}
            </ul>
            <p className="font-mono text-[10px] text-zinc-700 pt-2">
              No &quot;profit&quot;, &quot;guaranteed&quot;, or &quot;signal&quot; implied. Estimates only. Not financial advice.
            </p>
          </div>
        )}
      </div>

      {/* Capital selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest mr-1">Capital:</span>
        {CAPITAL_OPTIONS.map(c => (
          <button
            key={c}
            onClick={() => setCapital(c)}
            className={`font-mono text-xs px-3 py-1.5 border transition-colors duration-100
              ${capital === c
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
          >
            {CAPITAL_LABELS[c]}
          </button>
        ))}
        <span className="font-mono text-[10px] text-zinc-600 ml-2">per-side · two-sided posting</span>
      </div>

      {/* Summary bar */}
      {meta && markets.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
            <div className="font-mono text-lg font-bold text-zinc-200 tabular-nums">{meta.processed}</div>
            <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">programs scanned</div>
          </div>
          <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
            <div className="font-mono text-lg font-bold text-emerald-400 tabular-nums">{saneCount}</div>
            <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">clean at {CAPITAL_LABELS[capital]}</div>
          </div>
          <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
            <div className="font-mono text-lg font-bold text-zinc-300 tabular-nums">
              ${Math.round(totalPool).toLocaleString()}
            </div>
            <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">total pool $/day</div>
          </div>
          <div className="border border-red-900/30 bg-red-950/10 p-3 text-center">
            <div className="font-mono text-lg font-bold text-red-400 tabular-nums">{trapCount}</div>
            <div className="font-mono text-[10px] text-red-800 uppercase mt-0.5">TRAP (pushed down)</div>
          </div>
        </div>
      )}

      {/* Market table */}
      {sorted.length > 0 && (
        <section className="space-y-1">
          <div className="flex items-center gap-3 flex-wrap mb-2">
            <span className="font-mono text-xs text-zinc-400 uppercase tracking-widest">
              Reward markets — sane first · TRAP/WARN/flagged last
            </span>
            <span className="font-mono text-[10px] text-zinc-600">
              {CAPITAL_LABELS[capital]} capital · flat pro-rata observed model
            </span>
          </div>

          <div className="grid grid-cols-12 gap-2 pb-1 border-b border-zinc-800 font-mono text-[10px] text-zinc-600 uppercase tracking-widest">
            <div className="col-span-1">#</div>
            <div className="col-span-5">Market / flags</div>
            <div className="col-span-2">Pool / period</div>
            <div className="col-span-2">Depth (bid/ask)</div>
            <div className="col-span-2">Est. share / gross</div>
          </div>

          {sorted.map((m, i) => (
            <KMarketRow key={m.ticker} market={m} capital={capital} rank={i + 1} />
          ))}
        </section>
      )}

      {markets.length === 0 && data && !data.error && (
        <div className="border border-zinc-800 bg-zinc-900 p-8 text-center">
          <p className="font-mono text-sm text-zinc-400">No reward-eligible markets found in this scan.</p>
        </div>
      )}

      {/* Footer */}
      <div className="border-t border-zinc-800 pt-4 space-y-1">
        <p className="font-mono text-[10px] text-zinc-700 leading-relaxed">
          {meta?.disclaimer ?? 'ESTIMATE ONLY · Kalshi LIP scoring formula not public · behavioral inference · not financial advice'}
        </p>
        <p className="font-mono text-[10px] text-zinc-700">
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

  const markets = data?.markets ?? [];
  const meta    = data?.meta;
  const isStale = data?.stale ?? true;

  const sorted    = sortMarkets(markets, capital, sortMode);
  const openCount = markets.filter(m => m.gapClass === 'OPEN').length;
  const levelKey  = String(capital);
  const saneCount = sorted.filter(m => m.levels[levelKey]?.flags.length === 0).length;
  const totalPool = markets.reduce((s, m) => s + m.rewardsDailyRate, 0);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-7">

        {/* Platform toggle */}
        <div className="flex items-center gap-4">
          <PlatformToggle platform={platform} onChange={setPlatform} />
          <span className="font-mono text-[10px] text-zinc-600 uppercase tracking-widest">
            {platform === 'polymarket' ? 'Polymarket CLOB · Read-only · Typical placement estimate · No orders placed'
                                       : 'Kalshi LIP · Read-only · Observed model · No orders placed'}
          </span>
        </div>

        {/* ── Polymarket view ── */}
        {platform === 'polymarket' && (
          <>
            {/* Header */}
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="font-mono text-xl font-bold text-zinc-100 tracking-tight">
                LIQUIDITY REWARDS
              </h1>
              {meta && !isStale && (
                <span className="flex items-center gap-1.5 font-mono text-xs text-emerald-400 border border-emerald-600/40 bg-emerald-950/30 px-2 py-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  LIVE
                </span>
              )}
              {isStale && (
                <span className="font-mono text-xs text-orange-400 border border-orange-500/40 px-2 py-0.5">STALE</span>
              )}
              <span className="font-mono text-[10px] text-zinc-600 ml-auto">
                {lastFetch ? `fetched ${ago(lastFetch.toISOString())}` : '—'}
                {meta ? ` · data ${ago(meta.generatedAt)}` : ''}
              </span>
            </div>

            {/* Subtitle */}
            <p className="font-mono text-sm text-zinc-400 leading-relaxed">
              Polymarket pays makers who rest limit orders near the mid — filled or not.{' '}
              <span className="text-zinc-300">Real pools, your measured share.</span>
            </p>

            {/* Stale warning */}
            {isStale && meta && (
              <div className="border border-orange-600/40 bg-orange-950/15 px-4 py-3 font-mono text-xs text-orange-400">
                Data is stale (last scan: {ago(meta.generatedAt)}). Agent may be restarting or scanning — check back shortly.
              </div>
            )}

            {fetchError && (
              <div className="font-mono text-xs text-red-400 border border-red-800 bg-red-950/20 px-3 py-2">
                {fetchError}
              </div>
            )}

            {/* Honest framing */}
            <div className="border border-zinc-700/50 bg-zinc-900/40">
              <button
                className="w-full flex items-center justify-between px-4 py-3 text-left"
                onClick={() => setHowToOpen(v => !v)}
              >
                <span className="font-mono text-[10px] text-zinc-400 uppercase tracking-widest">
                  How to read these numbers
                </span>
                <span className="font-mono text-[10px] text-zinc-600">{howToOpen ? '▲ close' : '▼ expand'}</span>
              </button>

              {howToOpen && (
                <div className="px-4 pb-4 space-y-2 border-t border-zinc-800">
                  <ul className="mt-3 space-y-2">
                    {[
                      ['Pool $/day (real)', 'The dollar amount Polymarket allocates to reward makers on this market per day. This is the actual program rate — not an estimate.'],
                      ['Existing depth', 'Dollar notional (price × size) of all qualifying resting orders currently in the CLOB within the reward band. This is your competition. It changes continuously.'],
                      ['Typ. est. share', 'Estimated pool fraction using Polymarket\'s quadratic formula S(v,s)=((v-s)/v)². TYPICAL placement: both sides posted at s=v/2 (half the half-band, S=0.25) — a realistic farming position. Range shows outer-band low (s=0.8v, S=0.04) to near-mid high (s=0.1¢). Actual share depends on exact resting price and competitor re-quoting. Share compresses as makers enter.'],
                      ['Est. gross reward/day', 'share × pool $/day. GROSS — adverse-fill risk (being picked off when you\'re wrong) is not subtracted. That risk rises with volatility.'],
                      ['THIN BOOK flag', 'Gross yield >5%/day at this capital: the book is very thin and your share will compress as other makers arrive.'],
                      ['BELOW FLOOR flag', 'Gross reward <$1/day at this capital: Polymarket pays out in whole dollars; this position likely earns nothing.'],
                      ['Adverse risk class', 'LOW = slow-moving market, far from resolution. HIGH = near expiry or high recent volatility. HIGH-risk markets are likely to see informed flow picking off your orders.'],
                      ['OPEN BAND badge', 'Thinly-covered reward band at $500 capital (≥20% estimated share) with a meaningful pool and LOW or MEDIUM adverse-fill risk. This marks where there is room to enter — not a promised return. The window fills quickly as other makers arrive and share compresses. All figures are estimates.'],
                      ['GAP · ADVERSE RISK badge', 'Band is thinly covered — but precisely because HIGH volatility deters other makers from resting orders. Not a free opportunity: informed flow is likely to pick off your resting orders at a loss that exceeds the reward income.'],
                    ].map(([term, def]) => (
                      <li key={term} className="font-mono text-[11px] text-zinc-500 leading-relaxed pl-3 border-l border-zinc-700/40">
                        <span className="text-zinc-400">{term}:</span> {def}
                      </li>
                    ))}
                  </ul>
                  <p className="font-mono text-[10px] text-zinc-700 pt-2">
                    No &quot;profit&quot;, &quot;guaranteed&quot;, or &quot;signal&quot; implied. These are estimates for educational and research purposes only.
                  </p>
                </div>
              )}
            </div>

            {/* Capital selector */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest mr-1">Capital:</span>
              {CAPITAL_OPTIONS.map(c => (
                <button
                  key={c}
                  onClick={() => setCapital(c)}
                  className={`font-mono text-xs px-3 py-1.5 border transition-colors duration-100
                    ${capital === c
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
                >
                  {CAPITAL_LABELS[c]}
                </button>
              ))}
              <span className="font-mono text-[10px] text-zinc-600 ml-2">
                per-side estimate — two-sided posting assumed
              </span>
            </div>

            {/* Summary bar */}
            {meta && markets.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
                  <div className="font-mono text-lg font-bold text-zinc-200 tabular-nums">{meta.totalMarkets}</div>
                  <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">markets scanned</div>
                </div>
                <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
                  <div className="font-mono text-lg font-bold text-emerald-400 tabular-nums">{saneCount}</div>
                  <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">
                    clean at {CAPITAL_LABELS[capital]}
                  </div>
                </div>
                <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
                  <div className="font-mono text-lg font-bold text-zinc-300 tabular-nums">
                    ${totalPool.toLocaleString()}
                  </div>
                  <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">total pool $/day</div>
                </div>
                <div
                  className={`border p-3 text-center cursor-pointer transition-colors ${
                    openCount > 0
                      ? 'border-emerald-700/50 bg-emerald-950/20 hover:bg-emerald-950/35'
                      : 'border-zinc-800 bg-zinc-900'
                  }`}
                  onClick={() => openCount > 0 && setSortMode(m => m === 'gap' ? 'default' : 'gap')}
                  title={openCount > 0 ? 'Toggle: surface open-band markets to the top' : 'No open bands at this scan'}
                >
                  <div className={`font-mono text-lg font-bold tabular-nums ${openCount > 0 ? 'text-emerald-400' : 'text-zinc-600'}`}>
                    {openCount}
                  </div>
                  <div className={`font-mono text-[10px] uppercase mt-0.5 ${openCount > 0 ? 'text-emerald-600' : 'text-zinc-700'}`}>
                    {sortMode === 'gap' ? '▲ open bands (active)' : 'open band gaps'}
                  </div>
                </div>
              </div>
            )}

            {/* Market table */}
            {sorted.length > 0 ? (
              <section className="space-y-1">
                <div className="flex items-center gap-3 flex-wrap mb-2">
                  <span className="font-mono text-xs text-zinc-400 uppercase tracking-widest">
                    {sortMode === 'gap'
                      ? 'Open-band gaps first — est. share ≥ 20% at $500, LOW/MED risk'
                      : 'Reward markets — LOW adverse-risk sane first, flagged last'}
                  </span>
                  <span className="font-mono text-[10px] text-zinc-600">
                    {CAPITAL_LABELS[capital]} capital · depth snapshot every 15 min
                  </span>
                  <button
                    onClick={() => setSortMode(m => m === 'gap' ? 'default' : 'gap')}
                    className={`ml-auto font-mono text-[10px] px-2.5 py-1 border transition-colors ${
                      sortMode === 'gap'
                        ? 'border-emerald-600/60 bg-emerald-950/30 text-emerald-400'
                        : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {sortMode === 'gap' ? '▲ open bands first' : 'open-band gaps first'}
                  </button>
                </div>

                {sortMode === 'gap' && openCount === 0 && (
                  <div className="border border-zinc-800 bg-zinc-900/50 px-4 py-3 font-mono text-[11px] text-zinc-500">
                    No open band gaps detected in this scan — all reward bands are adequately covered at the 20% share threshold.
                    Check back after the next 15-min depth snapshot.
                  </div>
                )}

                <div className="grid grid-cols-12 gap-2 pb-1 border-b border-zinc-800 font-mono text-[10px] text-zinc-600 uppercase tracking-widest">
                  <div className="col-span-1">#</div>
                  <div className="col-span-5">Market / risk / flags</div>
                  <div className="col-span-2">Pool + depth</div>
                  <div className="col-span-2">Est. share</div>
                  <div className="col-span-2">Est. gross/day</div>
                </div>

                {sorted.map((m, i) => (
                  <MarketCard key={m.conditionId} market={m} capital={capital} rank={i + 1} />
                ))}
              </section>
            ) : (
              <div className="border border-zinc-800 bg-zinc-900 p-8 text-center space-y-2">
                <p className="font-mono text-sm text-zinc-400">
                  {data === null
                    ? 'Loading reward data…'
                    : isStale
                      ? 'Agent is scanning — data will appear once the first cycle completes (~3 min).'
                      : 'No reward-eligible markets found in this scan.'}
                </p>
                <p className="font-mono text-xs text-zinc-600">
                  First scan runs ~10 s after agent start. Refreshes every 15 min.
                </p>
              </div>
            )}

            {/* Disclaimer footer */}
            <div className="border-t border-zinc-800 pt-4 space-y-1">
              <p className="font-mono text-[10px] text-zinc-700 leading-relaxed">
                {meta?.disclaimer ?? 'Estimates only. Adverse-fill risk not subtracted. Not financial advice.'}
              </p>
              <p className="font-mono text-[10px] text-zinc-700">
                Read-only. No orders placed. No login required.
              </p>
            </div>
          </>
        )}

        {/* ── Kalshi view ── */}
        {platform === 'kalshi' && <KalshiView />}

      </div>
    </div>
  );
}
