'use client';

import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import Link from 'next/link';
import SectionHelp from '@/app/components/SectionHelp';
import EdgeChip, { type EdgeChipVariant } from '@/app/components/ui/EdgeChip';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FuturesCoin {
  markPrice?:            number | null;
  fundingRate:           number;
  fundingIntervalHours?: number;
  nextFundingTime?:      number;
  openInterest?:         number | null;
}

interface SlipPoint {
  size:          number;
  fillable:      boolean;
  slipBps:       number | null;
  slipUsd:       number | null;
  grossDayUsd:   number;
  netDayUsd:     number | null;
  slipOverGross: number | null;
  state:         'GREEN' | 'YELLOW' | 'RED';
}

interface SpreadItem {
  coin:               string;
  shortExchange:      string;
  longExchange:       string;
  frShort:            number;
  frLong:             number;
  intervalHoursShort: number;
  intervalHoursLong:  number;
  shortIsDex:         boolean;
  longIsDex:          boolean;
  hasDexLeg:          boolean;
  grossApy:           number;
  netApy30d:          number;
  totalFeesPct:       number;
  breakevenDays:      number;
  status:             'HARVEST' | 'CAUTION' | 'MARGINAL';
  liquidityTier:      string | null;
  capacityUsd:        number | null;          // = greenCapacityUsd when fresh
  thinFlag:           boolean;
  depthThin:          boolean;
  depthNote:          string | null;
  oneLegUnverified:   boolean;
  slipCurve:          SlipPoint[] | null;
  greenCapacityUsd:   number | null;
  slipCurveMaxFillable: number | null;
}

interface SpotCoin {
  price:         number;
  change24hPct?: number;
}

interface Meta {
  feePerLeg:    { cex: number; dex: number; gateio?: number; bitget?: number };
  legCount:     number;
  periodsPerYr: { cex: number; hl: number };
  note:         string;
}

interface CexArbItem {
  coin:      string;
  low:       string;
  lowPrice:  number;
  high:      string;
  highPrice: number;
  spreadPct: number;
}

interface ApiResponse {
  ok:           boolean;
  generatedAt:  number | null;
  staleMinutes: number | null;
  futures:      Record<string, Record<string, FuturesCoin>>;
  spot:         Record<string, Record<string, SpotCoin>>;
  spreads:      SpreadItem[];
  cexArb:       CexArbItem[];
  meta:         Meta | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const APY_CAP = 200; // %/yr — never display annualized above this; cap before showing

function chipVariant(s: SpreadItem): EdgeChipVariant {
  if (s.oneLegUnverified) return 'signal';
  if (s.thinFlag || s.depthThin) return 'speculative';
  return 'cashable';
}

function fmtRate(fr: number, intervalHours?: number): string {
  const sign   = fr >= 0 ? '+' : '';
  const suffix = intervalHours === 1 ? '/hr' : '/8h';
  return `${sign}${fr.toFixed(4)}%${suffix}`;
}

function fmtApy(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%/yr`;
}

function fmtDayUsd(n: number): string {
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 0.005) return `${sign}<$0.01/day`;
  return `${sign}$${abs.toFixed(2)}/day`;
}

function fmtCapWords(n: number | null): string {
  if (n == null) return 'unknown';
  if (n >= 1_000_000) return `~$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `~$${Math.round(n / 1_000)}k`;
  return `~$${n}`;
}

function fmtUsd(n: number): string {
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  if (abs >= 100)    return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function rateCls(fr: number): string {
  if (fr > 0.005) return 'text-mint-deep font-medium';
  if (fr > 0)     return 'text-mint-deep/70';
  if (fr < 0)     return 'text-coral-ink/80';
  return 'text-muted';
}

function statusBadgeCls(s: string): string {
  if (s === 'HARVEST') return 'bg-mint-tint text-mint-deep border-mint/25';
  if (s === 'CAUTION') return 'bg-gold-tint text-gold border-gold/25';
  return 'bg-coral-tint/50 text-coral-ink/70 border-coral-ink/25';
}

function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function venueLabel(exchange: string): string {
  if (exchange === 'dydx')        return 'dYdX';
  if (exchange === 'hyperliquid') return 'Hyperliquid';
  if (exchange === 'gateio')      return 'Gate.io';
  if (exchange === 'bitget')      return 'Bitget';
  return capFirst(exchange);
}

// ── Slip-curve helpers ────────────────────────────────────────────────────────

function slipStateCls(state: 'GREEN' | 'YELLOW' | 'RED'): string {
  if (state === 'GREEN')  return 'text-mint-deep';
  if (state === 'YELLOW') return 'text-gold';
  return 'text-coral-ink';
}

function fillablePoints(curve: SlipPoint[] | null): SlipPoint[] {
  return (curve ?? []).filter(p => p.fillable);
}

function defaultSliderIdx(curve: SlipPoint[] | null, greenCapacity: number | null): number {
  const pts = fillablePoints(curve);
  if (!pts.length) return 0;
  if ((greenCapacity ?? 0) > 0) {
    let last = 0;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].state === 'GREEN') last = i;
    }
    return last;
  }
  return 0; // smallest fillable
}

function slipSortScore(s: SpreadItem): number {
  const pts = fillablePoints(s.slipCurve);
  if (!pts.length || !(s.greenCapacityUsd ?? 0)) return -Infinity;
  // sort key: net $/day at greenCapacityUsd
  const pt = pts.find(p => p.size === s.greenCapacityUsd);
  return pt?.netDayUsd ?? -Infinity;
}

// ── Sizing ────────────────────────────────────────────────────────────────────

type Leverage = 1 | 2 | 3 | 5;
const LEVERAGE_OPTIONS: Leverage[] = [1, 2, 3, 5];

function calcSpreadSizing(s: SpreadItem, capital: number, leverage: Leverage) {
  const N         = capital * leverage / 2;
  const feesUsd   = N * s.totalFeesPct / 100;
  const net30dUsd = N * s.grossApy / 100 * 30 / 365 - feesUsd;
  const netYrUsd  = N * s.netApy30d / 100;
  const dayUsd    = netYrUsd / 365;
  const roc       = capital > 0 ? netYrUsd / capital * 100 : 0;
  return { N, feesUsd, net30dUsd, netYrUsd, dayUsd, roc };
}

// ── Arb-type filter ───────────────────────────────────────────────────────────

type ArbType = 'all' | 'perp_perp' | 'spot_perp';

function TypeFilterToggle({
  value, onChange,
}: { value: ArbType; onChange: (v: ArbType) => void }) {
  const opts: { id: ArbType; label: string; disabled?: boolean; hint?: string; whyDisabled?: string }[] = [
    { id: 'all',       label: 'All' },
    { id: 'perp_perp', label: 'Perp / Perp' },
    {
      id: 'spot_perp', label: 'Spot / Perp', disabled: true, hint: 'coming soon',
      whyDisabled: 'Spot / Perp (cash & carry) scanning is not yet live. Currently only Perp / Perp cross-exchange funding differential is computed. Spot / Perp will appear here once the backend agent starts producing basisTrades.',
    },
  ];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="font-body text-[11px] uppercase tracking-wide text-muted shrink-0">
        Strategy
      </span>
      <div className="flex border border-line rounded-button overflow-hidden font-body text-[11px] divide-x divide-line">
        {opts.map(opt => (
          <button
            key={opt.id}
            disabled={!!opt.disabled}
            onClick={() => !opt.disabled && onChange(opt.id)}
            title={opt.whyDisabled ?? undefined}
            aria-disabled={!!opt.disabled}
            className={`relative px-3 py-1 transition-colors duration-100 ${
              value === opt.id
                ? 'bg-mint-deep text-white'
                : opt.disabled
                  ? 'text-muted/30 cursor-not-allowed'
                  : 'text-muted hover:text-ink-2'
            }`}
          >
            {opt.label}
            {opt.hint && (
              <span className="ml-1 text-[7px] text-text-muted/40 align-middle">{opt.hint}</span>
            )}
          </button>
        ))}
      </div>
      {value === 'perp_perp' && (
        <span className="font-body text-[11px] text-muted">
          Short one perp, long another — collect the funding differential
        </span>
      )}
    </div>
  );
}

// ── Funding settlement note ───────────────────────────────────────────────────

function FundingSettlementNote({ s }: { s: SpreadItem }) {
  const hasCex = !s.shortIsDex || !s.longIsDex;
  const hasHl  = s.shortExchange === 'hyperliquid' || s.longExchange === 'hyperliquid';
  const hasDydx = s.shortExchange === 'dydx'       || s.longExchange === 'dydx';
  const parts: string[] = [];
  if (hasCex)  parts.push('CEX legs settle every 8h in USDT');
  if (hasHl)   parts.push('Hyperliquid settles hourly in USDC');
  if (hasDydx) parts.push('dYdX settles hourly in USDC');
  return (
    <p className="font-body text-[11px] text-muted/60 leading-relaxed">
      {parts.join(' · ')}.
      {' '}APY above is annualized — actual receipt is per interval, varies each reset.
    </p>
  );
}

// ── Countdown ─────────────────────────────────────────────────────────────────

function nextFundingMs(futures: Record<string, Record<string, FuturesCoin>>): number | null {
  for (const coin of Object.keys(futures.binance ?? {})) {
    const nft = futures.binance?.[coin]?.nextFundingTime;
    if (nft && nft > Date.now()) return nft;
  }
  const now  = Date.now();
  const h8ms = 8 * 3_600_000;
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  let t = midnight.getTime();
  while (t <= now) t += h8ms;
  return t;
}

function nextHlFundingMs(futures: Record<string, Record<string, FuturesCoin>>): number | null {
  for (const data of Object.values(futures.hyperliquid ?? {})) {
    const nft = data?.nextFundingTime;
    if (nft && nft > Date.now()) return nft;
  }
  return Math.ceil(Date.now() / 3_600_000) * 3_600_000;
}

function FundingCountdown({ targetMs }: { targetMs: number | null }) {
  const [text, setText] = useState('—');
  useEffect(() => {
    if (targetMs == null) return;
    const update = () => {
      const ms = targetMs - Date.now();
      if (ms <= 0) { setText('NOW'); return; }
      const h   = Math.floor(ms / 3_600_000);
      const m   = Math.floor((ms % 3_600_000) / 60_000);
      const s   = Math.floor((ms % 60_000) / 1_000);
      const pad = (n: number) => String(n).padStart(2, '0');
      setText(`${pad(h)}:${pad(m)}:${pad(s)}`);
    };
    update();
    const t = setInterval(update, 1_000);
    return () => clearInterval(t);
  }, [targetMs]);
  return <span className="tabular-nums">{text}</span>;
}

// ── Capital control ───────────────────────────────────────────────────────────

function CapitalControl({
  capital, leverage, setCapital, setLeverage,
}: {
  capital:    number;
  leverage:   Leverage;
  setCapital: (n: number) => void;
  setLeverage:(n: Leverage) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <span className="font-body text-[11px] uppercase tracking-wide text-muted shrink-0">
        Your capital
      </span>
      <div className="flex items-center gap-1">
        <span className="font-body text-[11px] text-muted">$</span>
        <input
          type="number" min={0} step={100} value={capital}
          onChange={e => setCapital(Math.max(0, parseFloat(e.target.value) || 0))}
          className="w-[4.5rem] px-1.5 py-0.5 font-mono text-[11px] bg-bg-soft border border-line text-ink rounded-sm focus:border-mint/50 focus:outline-none tabular-nums"
        />
      </div>
      <div className="flex items-center gap-1">
        {LEVERAGE_OPTIONS.map(lev => (
          <button
            key={lev}
            onClick={() => setLeverage(lev)}
            title={
              lev === 1
                ? '1× — no leverage. Each leg sized to your full capital. No liquidation risk from basis moves.'
                : `${lev}× — both perp legs use ${lev}× margin. Each leg notional = capital × ${lev} / 2. Funding yield on capital is multiplied by ${lev}, but so is liquidation risk if the spot/perp basis moves against you. Not free yield.`
            }
            className={`px-1.5 py-0.5 font-mono text-[10px] border rounded-sm transition-colors duration-100 cursor-help ${
              leverage === lev
                ? 'bg-mint-deep text-white border-mint-deep'
                : 'border-line text-muted hover:border-ink-2 hover:text-ink'
            }`}
          >
            {lev}×
          </button>
        ))}
      </div>
      {leverage > 1 && (
        <span className="font-body text-[11px] text-gold">
          {leverage}× applies to both perp legs — liquidation risk if basis widens
        </span>
      )}
    </div>
  );
}

// ── Slip-aware card ───────────────────────────────────────────────────────────

function SlipAwareCard({ s }: { s: SpreadItem }) {
  const pts           = fillablePoints(s.slipCurve);
  const [idx, setIdx] = useState(() => defaultSliderIdx(s.slipCurve, s.greenCapacityUsd));
  const pt            = pts[idx] ?? null;
  const hasCurve      = pts.length > 0;
  const tgHref        = `https://t.me/Gaspola_bot?start=fund_${s.coin}`;
  const hasDex        = s.shortExchange === 'hyperliquid' || s.longExchange === 'hyperliquid'
                     || s.shortExchange === 'dydx'        || s.longExchange === 'dydx';
  const resetLabel    = hasDex ? 'hourly' : 'every 8h';

  return (
    <div className="py-5 border-b border-line/20 flex flex-col gap-3 last:border-b-0">

      {/* Signal chip row */}
      <div className="flex items-center gap-2 flex-wrap">
        <EdgeChip variant={chipVariant(s)} />
        {(s.thinFlag || s.depthThin) && (
          <span className="font-body text-[11px] text-gold bg-gold-tint px-2 py-0.5 rounded-pill">
            ⚠ thin depth
          </span>
        )}
        {s.liquidityTier && !s.thinFlag && (
          <span className="font-body text-[11px] text-muted">{s.liquidityTier}</span>
        )}
      </div>

      {/* Coin + legs */}
      <div>
        <span className="font-display font-bold text-ink" style={{ fontSize: 16 }}>{s.coin}</span>
        <div className="font-mono text-[11px] mt-1.5 leading-snug space-y-0.5">
          <div>
            <span className="text-coral-ink font-medium">↓ SHORT</span>
            <span className="text-muted"> on </span>
            <span className={s.shortIsDex ? 'text-mint-deep' : 'text-ink-2'}>{venueLabel(s.shortExchange)}</span>
            {s.shortIsDex && <span className="text-mint text-[9px] ml-1">DEX</span>}
            <span className="text-muted/60 ml-2 text-[10px]">collect {fmtRate(s.frShort, s.intervalHoursShort)}</span>
          </div>
          <div>
            <span className="text-mint-deep font-medium">↑ LONG</span>
            <span className="text-muted"> on </span>
            <span className={s.longIsDex ? 'text-mint-deep' : 'text-ink-2'}>{venueLabel(s.longExchange)}</span>
            {s.longIsDex && <span className="text-mint text-[9px] ml-1">DEX</span>}
            <span className="text-muted/60 ml-2 text-[10px]">pay {fmtRate(s.frLong, s.intervalHoursLong)}</span>
          </div>
        </div>
      </div>

      <p className="font-body text-[12px] text-muted leading-relaxed">
        Hold opposite positions on two exchanges and collect the funding-fee difference {resetLabel}.
        Market-neutral — not a bet on {s.coin} price direction.
      </p>

      {/* Slip-curve box */}
      {hasCurve ? (
        <div className="p-3 bg-bg-soft/60 rounded-[8px] flex flex-col gap-2">
          {/* Slider */}
          <div className="flex items-center gap-2">
            <span className="font-body text-[11px] text-muted shrink-0">Position</span>
            <input
              type="range"
              min={0}
              max={pts.length - 1}
              value={idx}
              step={1}
              onChange={e => setIdx(parseInt(e.target.value))}
              className="flex-1 h-[3px] accent-[#0FBE82] cursor-pointer"
            />
            <span className="font-mono text-[10px] tabular-nums text-ink-2 shrink-0 w-14 text-right">
              {fmtCapWords(pt?.size ?? 0)}
            </span>
            {pt && (
              <span className={`font-mono text-[9px] font-semibold shrink-0 w-10 text-right ${slipStateCls(pt.state)}`}>
                {pt.state}
              </span>
            )}
          </div>

          {/* $/day — dominant value */}
          {pt ? (
            <>
              <div className={`font-display font-bold tabular-nums leading-none ${
                s.oneLegUnverified ? 'text-muted'
                : pt.state === 'GREEN'  ? 'text-mint-deep'
                : pt.state === 'YELLOW' ? 'text-gold'
                : 'text-coral-ink'
              }`} style={{ fontSize: 22 }}>
                ≈ {pt.netDayUsd != null ? fmtDayUsd(pt.netDayUsd) : '—'}
              </div>
              {s.oneLegUnverified && (
                <div className="font-body text-[11px] text-muted">
                  1 leg predicted — rate unconfirmed
                </div>
              )}
              <div className="font-body text-[11px] text-ink-2">
                incl. modeled entry/exit slippage (14d)
              </div>
              {/* Annualized % — demoted, capped, labeled */}
              <div className="font-body text-[11px] text-muted">
                {pt.netDayUsd != null && pt.size > 0 ? (
                  <>
                    {fmtApy(Math.min(pt.netDayUsd * 365 / pt.size * 100, APY_CAP))}
                    {pt.netDayUsd * 365 / pt.size * 100 > APY_CAP && ' (capped)'}
                    {' '}<span className="text-muted/70">est. %/yr — run-rate, not guaranteed</span>
                  </>
                ) : (
                  <span className="text-muted/70">est. %/yr — run-rate, not guaranteed</span>
                )}
              </div>
              {(s.greenCapacityUsd ?? 0) === 0 && (
                <div className="font-body text-[11px] text-muted leading-snug">
                  Thin book — all sizes above slippage threshold. Drag slider to explore.
                </div>
              )}
            </>
          ) : null}
        </div>
      ) : (
        <div className="p-3 bg-bg-soft/60 rounded-[8px] font-body text-[12px] text-muted">
          Depth data pending — check detail page for estimates
        </div>
      )}

      {s.depthThin && s.depthNote && (
        <p className="font-body text-[11px] text-gold leading-snug">{s.depthNote}</p>
      )}

      <FundingSettlementNote s={s} />

      <div className="flex items-center justify-between gap-2 flex-wrap">
        {s.greenCapacityUsd != null && (
          <span className="font-body text-[12px] text-muted">
            Green cap {fmtCapWords(s.greenCapacityUsd)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Link
            href={`/dashboard/funding-arb/${s.coin}-${s.shortExchange}-${s.longExchange}`}
            className="font-body text-[11px] px-2.5 py-1 border border-line text-muted hover:border-ink-2 hover:text-ink-2 rounded-button transition-colors duration-100 whitespace-nowrap"
          >
            Execution guide →
          </Link>
          <a
            href={tgHref}
            target="_blank"
            rel="noopener noreferrer"
            className="font-body text-[11px] px-2.5 py-1 border border-mint/25 text-mint hover:border-mint/50 hover:text-mint-deep rounded-button transition-colors duration-100 whitespace-nowrap"
          >
            ✈ Follow
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Opportunity cards / list ──────────────────────────────────────────────────

const CARDS_DEFAULT = 6;

type OppView = 'cards' | 'list';

function OpportunityCards({
  spreads, capital, leverage,
}: {
  spreads:  SpreadItem[];
  capital:  number;
  leverage: Leverage;
}) {
  const [showMore, setShowMore] = useState(false);
  const [view,     setView]     = useState<OppView>('cards');

  // Sort by net $/day at greenCapacityUsd; $0-green and no-curve sink to bottom
  const sorted = [...spreads].sort((a, b) => {
    const as = slipSortScore(a), bs = slipSortScore(b);
    return as !== bs ? bs - as : b.netApy30d - a.netApy30d;
  });

  // Best spread per unique coin (post-sort → best green-capacity coin first)
  const seenCoins = new Set<string>();
  const allItems: SpreadItem[] = [];
  for (const s of sorted) {
    if (!seenCoins.has(s.coin)) {
      seenCoins.add(s.coin);
      allItems.push(s);
    }
  }

  if (allItems.length === 0) return null;

  const visible   = showMore ? allItems : allItems.slice(0, CARDS_DEFAULT);
  const remaining = allItems.length - CARDS_DEFAULT;
  const N0        = capital * leverage / 2;

  return (
    <div className="mb-5">
      {/* View toggle + capacity explainer */}
      <div className="flex items-center justify-between mb-1">
        <span className="font-body text-[11px] text-muted uppercase tracking-wide">
          Top opportunities · best per asset
        </span>
        <div className="flex border border-line rounded-button overflow-hidden font-body text-[11px]">
          {(['cards', 'list'] as OppView[]).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 capitalize transition-colors duration-100 ${
                view === v
                  ? 'bg-mint-deep text-white'
                  : 'text-muted hover:text-ink-2'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <p className="font-body text-[11px] text-muted mb-3">
        Capacity = size you can enter before slippage eats &gt;30% of the yield.
        Most altcoin perp books are thin; green ranges are deliberately conservative.
        Sorted by net $/day at green capacity.
      </p>

      {/* Cards view — flat, no outer border */}
      {view === 'cards' && (
        <div className="grid gap-x-8 gap-y-0 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map(s => (
            <SlipAwareCard key={`${s.coin}-${s.shortExchange}-${s.longExchange}`} s={s} />
          ))}
        </div>
      )}

      {/* List view — hairline dividers, no outer border */}
      {view === 'list' && (
        <div className="divide-y divide-border/15">
          {visible.map(s => {
            const dayUsd  = N0 > 0 ? (N0 * s.netApy30d / 100) / 365 : null;
            const feesUsd = N0 > 0 ? N0 * s.totalFeesPct / 100 : null;
            const rocPct  = capital > 0 ? leverage * s.netApy30d / 2 : null;
            const tgHref  = `https://t.me/Gaspola_bot?start=fund_${s.coin}`;
            return (
              <div
                key={`${s.coin}-${s.shortExchange}-${s.longExchange}`}
                className="py-3 flex flex-wrap items-baseline gap-x-4 gap-y-1.5 hover:bg-bg-soft/50 transition-colors duration-100"
              >
                {/* Asset */}
                <span className="font-display font-bold text-ink w-12 shrink-0" style={{ fontSize: 14 }}>
                  {s.coin}
                </span>

                {/* Action */}
                <span className="font-mono text-[11px] text-ink-2">
                  <span className="text-coral-ink">↓ SHORT</span>
                  <span className="text-muted"> on </span>
                  <span className={s.shortIsDex ? 'text-mint-deep' : ''}>{venueLabel(s.shortExchange)}</span>
                  <span className="text-muted/40 mx-1.5">/</span>
                  <span className="text-mint-deep">↑ LONG</span>
                  <span className="text-muted"> on </span>
                  <span className={s.longIsDex ? 'text-mint-deep' : ''}>{venueLabel(s.longExchange)}</span>
                </span>

                {/* $/day — dominant value */}
                <span className="font-mono tabular-nums ml-auto sm:ml-0">
                  {dayUsd !== null && capital > 0 ? (
                    <>
                      <span className={`font-display font-bold ${s.oneLegUnverified ? 'text-muted' : 'text-mint-deep'}`} style={{ fontSize: 14 }}>
                        ≈ {fmtDayUsd(dayUsd)}
                      </span>
                      {s.oneLegUnverified ? (
                        <span className="font-body text-[11px] text-muted ml-2">
                          1 leg predicted — rate unconfirmed
                        </span>
                      ) : (
                        feesUsd !== null && feesUsd > 0 && (
                          <span className="font-body text-[11px] text-muted ml-2">fees back in {s.breakevenDays}d</span>
                        )
                      )}
                    </>
                  ) : (
                    <span className="font-body text-[11px] text-muted">set capital above</span>
                  )}
                </span>

                {/* Annualized % — demoted, capped */}
                <span className="font-body text-[11px] text-muted tabular-nums">
                  {rocPct !== null
                    ? `${fmtApy(Math.min(rocPct, APY_CAP))}${rocPct > APY_CAP ? ' (capped)' : ''} est. %/yr · run-rate, not guaranteed`
                    : '—'}
                </span>

                {s.depthThin && s.depthNote && (
                  <span className="font-body text-[11px] text-gold">{s.depthNote}</span>
                )}

                {/* Signal chip */}
                <EdgeChip variant={chipVariant(s)} />

                {/* Green capacity */}
                {s.greenCapacityUsd != null && (
                  <span className="font-body text-[11px] text-muted">
                    green cap {fmtCapWords(s.greenCapacityUsd)}
                  </span>
                )}

                {/* Guide + Follow */}
                <Link
                  href={`/dashboard/funding-arb/${s.coin}-${s.shortExchange}-${s.longExchange}`}
                  className="font-body text-[11px] px-2.5 py-1 border border-line text-muted hover:border-ink-2 hover:text-ink-2 rounded-button transition-colors duration-100 whitespace-nowrap"
                >
                  Guide →
                </Link>
                <a
                  href={tgHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-body text-[11px] px-2.5 py-1 border border-mint/25 text-mint hover:border-mint/50 hover:text-mint-deep rounded-button transition-colors duration-100 whitespace-nowrap"
                >
                  ✈ Follow
                </a>
              </div>
            );
          })}
        </div>
      )}

      {remaining > 0 && (
        <button
          onClick={() => setShowMore(v => !v)}
          className="mt-4 font-body text-sm text-mint hover:text-mint-deep transition-colors duration-100"
        >
          {showMore
            ? 'Show fewer opportunities ↑'
            : `Show ${remaining} more opportunities ↓`}
        </button>
      )}
    </div>
  );
}

// ── Status legend (advanced only) ─────────────────────────────────────────────

function StatusLegend() {
  return (
    <div className="px-4 py-2 bg-bg-elevated/20 border-b border-border/30 flex flex-wrap gap-x-5 gap-y-0.5 items-center">
      <span className="font-mono text-[9px]">
        <span className="text-positive font-semibold">HARVEST</span>
        <span className="text-text-muted"> = fees back in ≤5 days</span>
      </span>
      <span className="font-mono text-[9px]">
        <span className="text-warning font-semibold">CAUTION</span>
        <span className="text-text-muted"> = 5–10 days</span>
      </span>
      <span className="font-mono text-[9px]">
        <span className="text-negative/70 font-semibold">MARGINAL</span>
        <span className="text-text-muted"> = {'>'}10 days — spread likely shifts first</span>
      </span>
      <span className="font-mono text-[9px] ml-auto hidden sm:inline">
        <span className="text-accent">DEEP</span>
        <span className="text-text-muted"> &gt;$50M · </span>
        <span className="text-text-secondary">OK</span>
        <span className="text-text-muted"> &gt;$10M · </span>
        <span className="text-warning">THIN</span>
        <span className="text-text-muted"> &gt;$1M</span>
      </span>
    </div>
  );
}

// ── Table helpers ─────────────────────────────────────────────────────────────

function LiqChip({ tier, thin }: { tier: string | null; thin: boolean }) {
  if (!tier) return <span className="font-mono text-[9px] text-text-muted">—</span>;
  const cls: Record<string, string> = {
    DEEP:        'border-accent/40 text-accent',
    OK:          'border-border text-text-secondary',
    THIN:        'border-warning/50 text-warning',
    'VERY THIN': 'border-negative/40 text-negative/80',
  };
  return (
    <span className={`px-1 py-[1px] border text-[8px] font-mono uppercase ${cls[tier] ?? 'border-border text-text-muted'}`}>
      {tier}{thin ? ' ⚠' : ''}
    </span>
  );
}

function FeeNote({ meta }: { meta: Meta | null }) {
  if (!meta) return null;
  return (
    <p className="font-mono text-[9px] text-text-muted mt-1.5 leading-relaxed">
      Fee/leg: Binance/Bybit/OKX {meta.feePerLeg.cex}% · Gate.io 0.05% · Bitget 0.06% · Hyperliquid {meta.feePerLeg.dex}% · dYdX 0.05%.
      Round-trip = 4 legs (open+close both sides). Net yield (30d) = gross APR × 30d − fees.
      MARGINAL = &gt;10d · CAUTION = &gt;5d · HARVEST = ≤5d.
      Green cap = largest size where entry+exit slippage (amortized over 14d) ≤ 30% of gross yield. $0 = no green range. Tier labels (DEEP ≥ $50M · OK ≥ $10M · THIN ≥ $1M) are OI-based.
    </p>
  );
}

const TABLE_HEADERS: { label: string; tip?: string; cls?: string }[] = [
  { label: 'Asset' },
  {
    label: 'Sell side (you collect)',
    tip:   'SHORT this exchange — you receive the funding fee paid by traders betting the price goes up',
  },
  {
    label: 'Buy side (you pay)',
    tip:   'LONG this exchange — you pay little or zero fee (negative rate = they pay you)',
  },
  {
    label: 'Net $/day · ROC ↓',
    tip:   '$/day on your capital (primary when capital is set), with run-rate ROC %/yr on total capital below. Fees deducted, 30d hold projected. NOT guaranteed — rate changes every 1h or 8h.',
    cls:   'text-positive',
  },
  {
    label: 'Before fees',
    tip:   'Gross annualized spread before any trading fees are subtracted',
  },
  {
    label: 'Round-trip fees',
    tip:   'Total taker fees to open and close both legs (4 transactions: open short, open long, close short, close long)',
  },
  {
    label: 'Days to repay fees',
    tip:   'How many days at the current spread before your trading fees are fully recovered',
  },
  { label: 'Status' },
  {
    label: 'Green cap',
    tip:   'Largest position size where slippage (modeled entry+exit, 14d amortized) stays ≤30% of gross yield. $0 = thin book; all sizes cost too much to enter.',
  },
];

function SpreadTable({
  spreads, meta, capital, leverage,
}: {
  spreads:  SpreadItem[];
  meta:     Meta | null;
  capital:  number;
  leverage: Leverage;
}) {
  return (
    <div>
      <StatusLegend />
      {spreads.length === 0 ? (
        <div className="py-8 text-center font-mono text-[10px] text-text-muted">No pairs in current data.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[11px] border-collapse">
            <thead>
              <tr className="border-b border-border">
                {TABLE_HEADERS.map(h => (
                  <th
                    key={h.label}
                    title={h.tip}
                    className={`px-3 py-2 text-left text-[9px] uppercase tracking-widest font-normal whitespace-nowrap ${h.cls ?? 'text-text-muted'} ${h.tip ? 'cursor-help' : ''}`}
                  >
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spreads.map(s => {
                const key        = `${s.coin}-${s.shortExchange}-${s.longExchange}`;
                const isMarginal = s.status === 'MARGINAL';
                const sz         = capital > 0 ? calcSpreadSizing(s, capital, leverage) : null;
                return (
                  <Fragment key={key}>
                    <tr className={`border-b ${sz ? 'border-border/20' : 'border-border/50'} hover:bg-bg-elevated/40 transition-colors duration-100 ${isMarginal ? 'opacity-50' : ''} ${s.thinFlag ? 'opacity-70' : ''}`}>
                      <td className="px-3 py-2.5 font-semibold text-text-primary">{s.coin}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={s.shortIsDex ? 'text-accent' : 'text-text-secondary'}>{venueLabel(s.shortExchange)}</span>
                        <span className="text-border mx-1">·</span>
                        <span className={rateCls(s.frShort)}>{fmtRate(s.frShort, s.intervalHoursShort)}</span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={s.longIsDex ? 'text-accent' : 'text-text-secondary'}>{venueLabel(s.longExchange)}</span>
                        <span className="text-border mx-1">·</span>
                        <span className={rateCls(s.frLong)}>{fmtRate(s.frLong, s.intervalHoursLong)}</span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {sz ? (
                          <div className="flex flex-col gap-0.5">
                            <span className={`text-base font-bold ${s.oneLegUnverified ? 'text-text-muted' : sz.roc > 0 ? 'text-positive' : 'text-negative/70'}`}>
                              {fmtDayUsd(sz.dayUsd)}
                            </span>
                            <span className="font-mono text-[9px] text-text-muted/60">
                              {fmtApy(sz.roc)} ROC · run-rate · excl. entry slippage
                            </span>
                          </div>
                        ) : (
                          <span className={`text-base font-bold ${s.netApy30d > 0 ? 'text-positive' : 'text-negative/70'}`}>
                            {fmtApy(s.netApy30d)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-[10px] text-text-muted">{fmtApy(s.grossApy)}</td>
                      <td className="px-3 py-2.5 tabular-nums text-text-muted text-[10px] whitespace-nowrap">
                        {s.totalFeesPct.toFixed(2)}%{s.hasDexLeg && <span className="text-accent ml-1">†</span>}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-text-secondary whitespace-nowrap">{s.breakevenDays}d</td>
                      <td className="px-3 py-2.5">
                        <span className={`px-1.5 py-[2px] border text-[9px] uppercase tracking-widest ${statusBadgeCls(s.status)}`}>
                          {s.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <div className="flex flex-col gap-0.5">
                          <LiqChip tier={s.liquidityTier} thin={s.thinFlag} />
                          {s.greenCapacityUsd != null && (
                            <span className={`font-mono text-[8px] ${s.greenCapacityUsd === 0 ? 'text-warning/70' : 'text-positive/70'}`}>
                              {s.greenCapacityUsd === 0 ? '$0 green' : fmtCapWords(s.greenCapacityUsd)}
                            </span>
                          )}
                          {s.depthThin && s.depthNote && (
                            <span className="font-mono text-[8px] text-warning/70 leading-tight">{s.depthNote}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {sz && (
                      <tr className="border-b border-border/50 bg-bg-elevated/10">
                        <td colSpan={9} className="px-3 py-1.5">
                          <div className="flex flex-wrap gap-x-4 font-mono text-[10px]">
                            {s.oneLegUnverified && (
                              <span className="text-text-muted/70 italic">1 leg unverified — spread uses predicted rate, may be overstated.</span>
                            )}
                            <span className="text-text-muted">N/leg <span className="text-text-primary tabular-nums">{fmtUsd(sz.N)}</span></span>
                            <span className="text-text-muted">Fees <span className="text-text-primary tabular-nums">{fmtUsd(sz.feesUsd)}</span></span>
                            <span className="text-text-muted">Net 30d <span className={`tabular-nums ${sz.net30dUsd >= 0 ? 'text-positive' : 'text-negative'}`}>{fmtUsd(sz.net30dUsd)}</span></span>
                            <span className="text-text-muted">Net/yr <span className={`tabular-nums ${sz.netYrUsd >= 0 ? 'text-positive' : 'text-negative'}`}>{fmtUsd(sz.netYrUsd)}</span></span>
                            <span className="ml-auto text-text-muted">ROC <span className={`tabular-nums font-semibold ${sz.roc >= 0 ? 'text-positive' : 'text-negative'}`}>{sz.roc >= 0 ? '+' : ''}{sz.roc.toFixed(1)}%/yr</span></span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {spreads.some(s => s.hasDexLeg) && (
            <div className="px-3 pb-2 pt-1 font-mono text-[9px] text-accent/70 space-y-0.5">
              {spreads.some(s => s.shortExchange === 'hyperliquid' || s.longExchange === 'hyperliquid') && (
                <div>† Hyperliquid: 0.025%/leg taker · USDC bridge ~10 min + ~$1–5 ETH gas one-time · resets HOURLY</div>
              )}
              {spreads.some(s => s.shortExchange === 'dydx' || s.longExchange === 'dydx') && (
                <div>‡ dYdX v4: 0.05%/leg taker · USDC bridge via Noble ~5 min + ~$3–10 gas · resets HOURLY</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Rate heatmap ──────────────────────────────────────────────────────────────

function RateHeatmap({ futures }: { futures: Record<string, Record<string, FuturesCoin>> }) {
  const CEX_ORDER    = ['binance', 'bybit', 'okx'];
  const DEX_ORDER    = ['hyperliquid', 'dydx'];
  const allExchanges = [
    ...CEX_ORDER.filter(e => futures[e]),
    ...DEX_ORDER.filter(e => futures[e]),
  ];
  if (allExchanges.length === 0) return null;

  const coinSet: Record<string, true> = {};
  for (const coins of Object.values(futures)) {
    for (const c of Object.keys(coins)) coinSet[c] = true;
  }
  const COIN_ORDER = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'AVAX', 'LINK'];
  const coins = [
    ...COIN_ORDER.filter(c => coinSet[c]),
    ...Object.keys(coinSet).filter(c => !COIN_ORDER.includes(c)).sort(),
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal">Asset</th>
            {allExchanges.map(ex => (
              <th key={ex} className={`px-3 py-2 text-left text-[9px] uppercase tracking-widest font-normal whitespace-nowrap ${DEX_ORDER.includes(ex) ? 'text-accent' : 'text-text-muted'}`}>
                {ex === 'dydx' ? 'dYdX (DEX)' : ex === 'hyperliquid' ? 'Hyperliquid (DEX)' : capFirst(ex)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {coins.map(coin => (
            <tr key={coin} className="border-b border-border/50 hover:bg-bg-elevated/40 transition-colors duration-100">
              <td className="px-3 py-2.5 font-semibold text-text-primary">{coin}</td>
              {allExchanges.map(ex => {
                const data = futures[ex]?.[coin];
                if (!data) return <td key={ex} className="px-3 py-2.5 text-text-muted/30 text-[10px]">—</td>;
                const intervalH = data.fundingIntervalHours ?? 8;
                return (
                  <td key={ex} className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                    <span className={rateCls(data.fundingRate)}>{fmtRate(data.fundingRate, intervalH)}</span>
                    {data.markPrice != null && (
                      <span className="ml-2 text-text-muted text-[9px]">
                        ${data.markPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── CEX spot arb ──────────────────────────────────────────────────────────────

function CexArbSection({ items }: { items: CexArbItem[] }) {
  return (
    <div>
      <div className="px-4 py-2 border-b border-border flex items-center justify-between flex-wrap gap-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">CEX Spot Arbitrage</span>
        <span className="font-mono text-[9px] text-text-muted">
          {items.length > 0
            ? `${items.length} spread${items.length > 1 ? 's' : ''} above 0.3% threshold`
            : 'spot price spread · threshold 0.3%'}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="px-4 py-6 text-center space-y-1">
          <div className="font-mono text-[11px] text-text-muted">No spot spread above threshold right now</div>
          <div className="font-mono text-[9px] text-text-muted/50">
            Scanner checks Binance · Bybit · OKX every 60s · threshold 0.3% · execution risk: slippage + withdrawal lag
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[11px] border-collapse">
            <thead>
              <tr className="border-b border-border">
                {['Asset', 'Buy on (low)', 'Buy price', 'Sell on (high)', 'Sell price', 'Spread'].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-[9px] uppercase tracking-widest font-normal text-text-muted whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map(a => (
                <tr key={`${a.coin}-${a.low}-${a.high}`} className="border-b border-border/50 hover:bg-bg-elevated/40 transition-colors duration-100">
                  <td className="px-3 py-2.5 font-semibold text-text-primary">{a.coin}</td>
                  <td className="px-3 py-2.5 text-text-secondary capitalize">{a.low}</td>
                  <td className="px-3 py-2.5 tabular-nums text-text-primary">
                    ${a.lowPrice.toLocaleString(undefined, { maximumFractionDigits: a.lowPrice > 1 ? 2 : 5 })}
                  </td>
                  <td className="px-3 py-2.5 text-text-secondary capitalize">{a.high}</td>
                  <td className="px-3 py-2.5 tabular-nums text-text-primary">
                    ${a.highPrice.toLocaleString(undefined, { maximumFractionDigits: a.highPrice > 1 ? 2 : 5 })}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums font-bold text-positive">+{a.spreadPct.toFixed(3)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 font-mono text-[9px] text-text-muted/60">
            Spread is gross · subtract withdrawal fee + transfer time · signals only, no execution.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CryptoPage() {
  const [data,         setData]         = useState<ApiResponse | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [capital,      setCapital]      = useState(1000);
  const [leverage,     setLeverage]     = useState<Leverage>(1);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [typeFilter,   setTypeFilter]   = useState<ArbType>('all');
  const pendingHashScroll               = useRef(false);
  const rafHandle                       = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res  = await fetch('/api/crypto', { cache: 'no-store' });
      const json: ApiResponse = await res.json();
      setData(json);
    } catch { /* keep stale */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Poll for the element after the panel is open, retrying up to 20 rAFs (~1s)
  const scrollToCexArb = useCallback(() => {
    let attempts = 0;
    const tryScroll = () => {
      const el = document.getElementById('cex-arb');
      if (el) {
        pendingHashScroll.current = false;
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (attempts < 20) {
        attempts++;
        rafHandle.current = requestAnimationFrame(tryScroll);
      }
    };
    // Double-rAF to run after React commits + paints
    rafHandle.current = requestAnimationFrame(() => {
      rafHandle.current = requestAnimationFrame(tryScroll);
    });
  }, []);

  // Scroll once the advanced panel has been opened by the hash link
  useEffect(() => {
    if (showAdvanced && pendingHashScroll.current) {
      scrollToCexArb();
    }
  }, [showAdvanced, scrollToCexArb]);

  // Hash deep-link: #cex-arb opens advanced section and scrolls to CEX spot arb
  useEffect(() => {
    const applyHash = () => {
      if (window.location.hash === '#cex-arb') {
        if (showAdvanced) {
          // Panel already open — effect above won't re-fire, so poll directly
          pendingHashScroll.current = true;
          scrollToCexArb();
        } else {
          pendingHashScroll.current = true;
          setShowAdvanced(true);
        }
      }
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => {
      window.removeEventListener('hashchange', applyHash);
      if (rafHandle.current !== null) cancelAnimationFrame(rafHandle.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cexNextMs    = data?.ok ? nextFundingMs(data.futures)   : null;
  const hlNextMs     = data?.ok ? nextHlFundingMs(data.futures) : null;
  const isStale      = (data?.staleMinutes ?? 0) > 5;
  // All current spreads are perp/perp — spot/perp (cash & carry) is not yet computed
  const allPairs     = data?.spreads ?? [];
  const filteredPairs = typeFilter === 'spot_perp' ? [] : allPairs; // spot_perp is coming soon
  const harvestPairs = filteredPairs.filter(s => s.status === 'HARVEST');
  const cautionPairs = filteredPairs.filter(s => s.status === 'CAUTION');
  const dexPairs     = filteredPairs.filter(s => s.hasDexLeg);
  const cexArbItems  = data?.cexArb ?? [];

  const N0         = capital * leverage / 2;
  const bestDayUsd = filteredPairs.length > 0 && capital > 0
    ? (N0 * filteredPairs[0].netApy30d / 100) / 365
    : null;

  return (
    <div className="max-w-[1200px] mx-auto px-4 py-6">

      {/* Header */}
      <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <div>
          <h1 className="font-display font-semibold text-xl text-ink">
            Funding Rate Monitor
          </h1>
          <p className="font-body text-sm text-muted mt-1">
            Cross-exchange spread · Binance / Bybit / OKX / Gate.io / Bitget · Hyperliquid / dYdX
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          {isStale && (
            <span className="font-body text-xs text-gold bg-gold-tint px-2 py-0.5 rounded-pill">
              DATA {data?.staleMinutes}m OLD
            </span>
          )}
          {data?.generatedAt && (
            <span className="font-body text-xs text-muted tabular-nums">
              {new Date(data.generatedAt).toLocaleTimeString('en-GB', { hour12: false })}
            </span>
          )}
          {!loading && !data?.ok && (
            <span className="font-body text-xs text-coral-ink">agent10 not running</span>
          )}
        </div>
      </div>

      {/* How this works — collapsible, collapsed by default */}
      <SectionHelp section="funding" />

      {/* Honest one-liner — rates are variable */}
      <p className="font-body text-xs text-muted mb-5 mt-3">
        Rates are variable and change hourly — these are current estimates, not locked.
      </p>

      {loading ? (
        <div className="py-20 text-center font-body text-sm text-muted animate-pulse">
          Loading…
        </div>
      ) : !data?.ok ? (
        <div className="py-20 text-center space-y-2">
          <div className="font-body text-sm text-coral-ink">No data</div>
          <div className="font-mono text-[10px] text-muted">
            pm2 start ecosystem.config.js --only agent10-binance
          </div>
        </div>
      ) : (
        <>
          {/* Strategy type filter */}
          <div className="mb-3 px-4 py-2.5 rounded-card bg-surface shadow-card border border-line">
            <TypeFilterToggle value={typeFilter} onChange={setTypeFilter} />
          </div>

          {/* Capital selector */}
          <div className="mb-5 px-4 py-2.5 rounded-card bg-surface shadow-card border border-line">
            <CapitalControl
              capital={capital} leverage={leverage}
              setCapital={setCapital} setLeverage={setLeverage}
            />
          </div>

          {/* Top opportunity cards — 6 visible, "show more" reveals the rest */}
          <OpportunityCards spreads={filteredPairs} capital={capital} leverage={leverage} />

          {/* ── Advanced / full data ──────────────────────────────────── */}
          <div className="border border-line rounded-card bg-surface shadow-card mb-5">
            <button
              onClick={() => setShowAdvanced(v => !v)}
              className="w-full px-4 py-3 flex items-center justify-between font-body text-[11px] text-muted hover:text-ink-2 hover:bg-bg-soft/40 rounded-card transition-colors duration-100"
            >
              <span className="uppercase tracking-wide">Advanced / full data</span>
              <span className="text-muted/50">{showAdvanced ? 'collapse ↑' : `${filteredPairs.length} pairs · expand ↓`}</span>
            </button>

            {showAdvanced && (
              <div className="border-t border-line">

                {/* Status counters + timers */}
                <div className="px-4 py-3 border-b border-line/40 flex flex-wrap gap-2 items-center">
                  {[
                    { label: 'HARVEST',  val: harvestPairs.length, cls: 'text-mint-deep border-mint/30 bg-mint-tint/30' },
                    { label: 'CAUTION',  val: cautionPairs.length, cls: 'text-gold border-gold/30 bg-gold-tint/30'       },
                    {
                      label: 'MARGINAL',
                      val:   filteredPairs.length - harvestPairs.length - cautionPairs.length,
                      cls:   'text-muted border-line opacity-50',
                    },
                    { label: 'CEX↔DEX', val: dexPairs.length,     cls: 'text-violet border-violet/30 bg-violet-tint/30' },
                    { label: 'TOTAL',   val: filteredPairs.length, cls: 'text-ink-2 border-line'                         },
                  ].map(({ label, val, cls }) => (
                    <div key={label} className={`px-2.5 py-1 border rounded-md font-body text-[11px] ${cls}`}>
                      <span className="font-bold tabular-nums mr-1">{val}</span>
                      {label}
                    </div>
                  ))}

                  {bestDayUsd !== null ? (
                    <div className="px-2.5 py-1 border border-mint/30 bg-mint-tint/30 rounded-md font-body text-[11px] text-mint-deep">
                      Best: <span className="font-bold">{fmtDayUsd(bestDayUsd)}</span>
                      <span className="text-[10px] text-mint-deep/60 ml-1">on ${capital.toLocaleString()}</span>
                    </div>
                  ) : filteredPairs.length > 0 ? (
                    <div className="px-2.5 py-1 border border-mint/30 bg-mint-tint/30 rounded-md font-body text-[11px] text-mint-deep"
                      title="Theoretical ceiling — rate changes hourly.">
                      Best ceiling: <span className="font-bold">{fmtApy(Math.min(filteredPairs[0].netApy30d, APY_CAP))}</span>
                    </div>
                  ) : null}

                  {/* Reset timers */}
                  <div className="ml-auto flex gap-4 shrink-0">
                    {cexNextMs != null && (
                      <span className="font-body text-[11px] text-muted">
                        CEX next: <span className="text-ink"><FundingCountdown targetMs={cexNextMs} /></span>
                      </span>
                    )}
                    {hlNextMs != null && (
                      <span className="font-body text-[11px] text-muted">
                        HL next: <span className="text-mint-deep"><FundingCountdown targetMs={hlNextMs} /></span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Full spread table */}
                <div id="funding-spreads" className="scroll-mt-16">
                  <div className="px-4 py-2 border-b border-line/40 flex items-center justify-between">
                    <span className="font-body text-[11px] uppercase tracking-wide text-muted">
                      All Pairs
                    </span>
                    <span className="font-body text-[11px] text-muted">
                      {filteredPairs.length} pairs · ranked by net yield (30d)
                    </span>
                  </div>
                  <SpreadTable spreads={filteredPairs} meta={data.meta} capital={capital} leverage={leverage} />
                  <div className="px-4 pb-3">
                    <FeeNote meta={data.meta} />
                  </div>
                </div>

                {/* Per-exchange rate heatmap */}
                <div className="border-t border-line">
                  <div className="px-4 py-2 border-b border-line/40 flex items-center justify-between flex-wrap gap-2">
                    <span className="font-body text-[11px] uppercase tracking-wide text-muted">
                      Per-Exchange Funding Rates
                    </span>
                    <span className="font-body text-[11px] text-muted">
                      Positive → shorts collect · Negative → longs collect ·{' '}
                      <span className="text-mint-deep">DEX = Hyperliquid (1h)</span>
                    </span>
                  </div>
                  <RateHeatmap futures={data.futures} />
                  <div className="px-4 py-2 border-t border-line/40 flex flex-wrap gap-x-6 gap-y-0.5">
                    <span className="font-body text-[11px] text-muted">
                      CEX next reset: <span className="text-ink"><FundingCountdown targetMs={cexNextMs} /></span>
                      <span className="ml-2 text-muted/50">(00:00, 08:00, 16:00 UTC)</span>
                    </span>
                    {data.futures.hyperliquid && (
                      <span className="font-body text-[11px] text-muted">
                        HL next reset: <span className="text-mint-deep"><FundingCountdown targetMs={hlNextMs} /></span>
                        <span className="ml-2 text-muted/50">(every UTC hour)</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Spot prices */}
                {Object.keys(data.spot.binance ?? {}).length > 0 && (
                  <div className="border-t border-line">
                    <div className="px-4 py-2 border-b border-line/40">
                      <span className="font-body text-[11px] uppercase tracking-wide text-muted">Spot Prices (Binance)</span>
                    </div>
                    <div className="flex flex-wrap gap-px">
                      {Object.entries(data.spot.binance).map(([coin, s]) => (
                        <div key={coin} className="flex-1 min-w-[110px] px-4 py-3 border-r border-line/50 last:border-0">
                          <div className="font-body text-[11px] text-muted mb-1">{coin}/USDT</div>
                          <div className="font-mono text-[13px] text-ink tabular-nums">
                            ${s.price.toLocaleString(undefined, { maximumFractionDigits: s.price > 1 ? 2 : 5 })}
                          </div>
                          {s.change24hPct != null && (
                            <div className={`font-body text-[11px] tabular-nums mt-0.5 ${s.change24hPct >= 0 ? 'text-mint-deep' : 'text-coral-ink'}`}>
                              {s.change24hPct >= 0 ? '+' : ''}{s.change24hPct.toFixed(2)}%
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* CEX spot arbitrage */}
                <div id="cex-arb" className="border-t border-line scroll-mt-24">
                  <CexArbSection items={cexArbItems} />
                </div>

              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
