'use client';

import { useEffect, useState, useCallback, Fragment } from 'react';
import SectionHelp from '@/app/components/SectionHelp';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FuturesCoin {
  markPrice?:            number | null;
  fundingRate:           number;
  fundingIntervalHours?: number;
  nextFundingTime?:      number;
  openInterest?:         number | null;
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
  capacityUsd:        number | null;
  thinFlag:           boolean;
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
  if (fr > 0.005) return 'text-positive font-medium';
  if (fr > 0)     return 'text-positive/70';
  if (fr < 0)     return 'text-negative/80';
  return 'text-text-muted';
}

function statusBadgeCls(s: string): string {
  if (s === 'HARVEST') return 'bg-positive/10 text-positive border-positive/25';
  if (s === 'CAUTION') return 'bg-warning/10 text-warning border-warning/25';
  return 'bg-negative/10 text-negative/70 border-negative/25';
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
      <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted shrink-0">
        Your capital
      </span>
      <div className="flex items-center gap-1">
        <span className="font-mono text-[10px] text-text-muted">$</span>
        <input
          type="number" min={0} step={100} value={capital}
          onChange={e => setCapital(Math.max(0, parseFloat(e.target.value) || 0))}
          className="w-[4.5rem] px-1.5 py-0.5 font-mono text-[11px] bg-bg-panel border border-border text-text-primary focus:border-accent/50 focus:outline-none tabular-nums"
        />
      </div>
      <div className="flex items-center gap-1">
        {LEVERAGE_OPTIONS.map(lev => (
          <button
            key={lev}
            onClick={() => setLeverage(lev)}
            className={`px-1.5 py-0.5 font-mono text-[10px] border transition-colors duration-100 ${
              leverage === lev
                ? 'bg-accent text-white border-accent'
                : 'border-border text-text-muted hover:border-text-secondary hover:text-text-primary'
            }`}
          >
            {lev}×
          </button>
        ))}
      </div>
      {leverage > 1 && (
        <span className="font-mono text-[9px] text-warning/70">liquidation risk at {leverage}×</span>
      )}
    </div>
  );
}

// ── Opportunity cards ─────────────────────────────────────────────────────────

const CARDS_DEFAULT = 6;

function OpportunityCards({
  spreads, capital, leverage,
}: {
  spreads:  SpreadItem[];
  capital:  number;
  leverage: Leverage;
}) {
  const [showMore, setShowMore] = useState(false);

  // Best spread per unique coin, all of them
  const seenCoins = new Set<string>();
  const allCards: SpreadItem[] = [];
  for (const s of spreads) {
    if (!seenCoins.has(s.coin)) {
      seenCoins.add(s.coin);
      allCards.push(s);
    }
  }

  if (allCards.length === 0) return null;

  const visible  = showMore ? allCards : allCards.slice(0, CARDS_DEFAULT);
  const remaining = allCards.length - CARDS_DEFAULT;
  const N0       = capital * leverage / 2;

  return (
    <div className="mb-5">
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map(s => {
          const dayUsd     = N0 > 0 ? (N0 * s.netApy30d / 100) / 365 : null;
          const feesUsd    = N0 > 0 ? N0 * s.totalFeesPct / 100 : null;
          const hasDex     = s.shortExchange === 'hyperliquid' || s.longExchange === 'hyperliquid'
                          || s.shortExchange === 'dydx'        || s.longExchange === 'dydx';
          const resetLabel = hasDex ? 'hourly' : 'every 8h';

          return (
            <div
              key={`${s.coin}-${s.shortExchange}-${s.longExchange}`}
              className={`border bg-bg-panel p-4 flex flex-col gap-3 ${
                s.status === 'HARVEST' ? 'border-positive/25' :
                s.status === 'CAUTION' ? 'border-warning/25' : 'border-border'
              }`}
            >
              {/* Badge + liquidity tier */}
              <div className="flex items-center justify-between">
                <span className={`px-1.5 py-[2px] border text-[9px] font-mono uppercase tracking-widest ${statusBadgeCls(s.status)}`}>
                  {s.status}
                </span>
                <span className="font-mono text-[9px] text-text-muted">
                  {s.thinFlag ? '⚠ thin liq.' : (s.liquidityTier ?? '')}
                </span>
              </div>

              {/* Headline action */}
              <div>
                <span className="font-mono text-[16px] font-bold text-text-primary">{s.coin}</span>
                <div className="font-mono text-[11px] mt-1.5 leading-snug space-y-0.5">
                  <div>
                    <span className="text-negative/80 font-medium">↓ SHORT</span>
                    <span className="text-text-muted"> on </span>
                    <span className={s.shortIsDex ? 'text-accent' : 'text-text-secondary'}>
                      {venueLabel(s.shortExchange)}
                    </span>
                    {s.shortIsDex && <span className="text-accent/60 text-[9px] ml-1">DEX</span>}
                    <span className="text-text-muted/50 ml-2 text-[10px]">collect {fmtRate(s.frShort, s.intervalHoursShort)}</span>
                  </div>
                  <div>
                    <span className="text-positive/80 font-medium">↑ LONG</span>
                    <span className="text-text-muted"> on </span>
                    <span className={s.longIsDex ? 'text-accent' : 'text-text-secondary'}>
                      {venueLabel(s.longExchange)}
                    </span>
                    {s.longIsDex && <span className="text-accent/60 text-[9px] ml-1">DEX</span>}
                    <span className="text-text-muted/50 ml-2 text-[10px]">pay {fmtRate(s.frLong, s.intervalHoursLong)}</span>
                  </div>
                </div>
              </div>

              {/* Plain-English */}
              <p className="font-mono text-[10px] text-text-muted leading-relaxed">
                Hold opposite positions on two exchanges and collect the funding-fee difference {resetLabel}.
                Market-neutral — not a bet on {s.coin} price direction.
              </p>

              {/* Primary: $/day */}
              {dayUsd !== null && capital > 0 ? (
                <div className="p-2.5 bg-bg-elevated/30 border border-border/40">
                  <div className="font-mono text-[22px] font-bold text-positive tabular-nums leading-none">
                    ≈ {fmtDayUsd(dayUsd)}
                  </div>
                  <div className="font-mono text-[10px] text-text-secondary mt-1">
                    on ${capital.toLocaleString()}{leverage > 1 ? ` · ${leverage}× leverage` : ''}
                  </div>
                  {feesUsd !== null && feesUsd > 0 && (
                    <div className="font-mono text-[10px] text-text-muted mt-1.5">
                      Fees {fmtUsd(feesUsd)} · paid back in {s.breakevenDays}d, then profit while spread holds.
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-2.5 bg-bg-elevated/30 border border-border/40 font-mono text-[10px] text-text-muted">
                  Enter capital above to see $/day estimate
                </div>
              )}

              {/* Secondary: annualized ceiling (honest, greyed) */}
              <div className="font-mono text-[10px] text-text-muted/60 leading-relaxed border-t border-border/20 pt-2.5">
                <span className="text-text-muted">{fmtApy(s.netApy30d)}</span>{' '}
                theoretical ceiling — assumes this rate holds all year.
                Changes {resetLabel}; treat as upper bound, not a promise.
              </div>

              {/* Liquidity in words */}
              {s.capacityUsd != null && (
                <div className="font-mono text-[10px] text-text-muted/70">
                  You can move up to {fmtCapWords(s.capacityUsd)} before impacting the market.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {remaining > 0 && (
        <button
          onClick={() => setShowMore(v => !v)}
          className="mt-4 font-mono text-[10px] text-accent/70 hover:text-accent transition-colors duration-100"
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
      Max size ≈ 1% of min OI or vol24h across both legs (DEEP ≥ $50M · OK ≥ $10M · THIN ≥ $1M).
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
    label: 'Net yield (30d) ↓',
    tip:   'Annualized % after round-trip fees, projected as if held 30 days. NOT guaranteed — rate changes every 1h or 8h.',
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
    label: 'Max size',
    tip:   '~1% of min open interest or 24h volume across both legs — practical cap before meaningful market impact',
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
                      <td className={`px-3 py-2.5 tabular-nums text-base font-bold ${s.netApy30d > 0 ? 'text-positive' : 'text-negative/70'}`}>
                        {fmtApy(s.netApy30d)}
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
                          {s.capacityUsd != null && (
                            <span className="font-mono text-[8px] text-text-muted">{fmtCapWords(s.capacityUsd)}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {sz && (
                      <tr className="border-b border-border/50 bg-bg-elevated/10">
                        <td colSpan={9} className="px-3 py-1.5">
                          <div className="flex flex-wrap gap-x-4 font-mono text-[10px]">
                            <span className="text-positive font-semibold tabular-nums">≈ {fmtDayUsd(sz.dayUsd)}</span>
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

  const cexNextMs    = data?.ok ? nextFundingMs(data.futures)   : null;
  const hlNextMs     = data?.ok ? nextHlFundingMs(data.futures) : null;
  const isStale      = (data?.staleMinutes ?? 0) > 5;
  const allPairs     = data?.spreads ?? [];
  const harvestPairs = allPairs.filter(s => s.status === 'HARVEST');
  const cautionPairs = allPairs.filter(s => s.status === 'CAUTION');
  const dexPairs     = allPairs.filter(s => s.hasDexLeg);
  const cexArbItems  = data?.cexArb ?? [];

  const N0         = capital * leverage / 2;
  const bestDayUsd = allPairs.length > 0 && capital > 0
    ? (N0 * allPairs[0].netApy30d / 100) / 365
    : null;

  return (
    <div className="max-w-[1200px] mx-auto px-4 py-6">

      {/* Header */}
      <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <div>
          <h1 className="font-mono text-sm uppercase tracking-widest text-text-primary">
            Funding Rate Monitor
          </h1>
          <p className="font-mono text-[10px] text-text-muted mt-0.5">
            Cross-exchange spread · Binance / Bybit / OKX / Gate.io / Bitget · Hyperliquid / dYdX
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          {isStale && (
            <span className="font-mono text-[10px] text-warning">DATA {data?.staleMinutes}m OLD</span>
          )}
          {data?.generatedAt && (
            <span className="font-mono text-[10px] text-text-muted tabular-nums">
              {new Date(data.generatedAt).toLocaleTimeString('en-GB', { hour12: false })}
            </span>
          )}
          {!loading && !data?.ok && (
            <span className="font-mono text-[10px] text-negative">agent10 not running</span>
          )}
        </div>
      </div>

      {/* How this works — collapsible, collapsed by default */}
      <SectionHelp section="funding" />

      {/* Honest one-liner — replaces the dense variability banner */}
      <p className="font-mono text-[10px] text-text-muted/70 mb-5 mt-3">
        Rates are variable and change hourly — these are current estimates, not locked.
      </p>

      {loading ? (
        <div className="py-20 text-center font-mono text-[10px] uppercase tracking-widest text-text-muted animate-pulse">
          Loading…
        </div>
      ) : !data?.ok ? (
        <div className="py-20 text-center space-y-2">
          <div className="font-mono text-[10px] uppercase tracking-widest text-negative">No data</div>
          <div className="font-mono text-[10px] text-text-muted">
            pm2 start ecosystem.config.js --only agent10-binance
          </div>
        </div>
      ) : (
        <>
          {/* Capital selector */}
          <div className="mb-5 px-4 py-2.5 bg-bg-panel border border-border">
            <CapitalControl
              capital={capital} leverage={leverage}
              setCapital={setCapital} setLeverage={setLeverage}
            />
          </div>

          {/* Top opportunity cards — 6 visible, "show more" reveals the rest */}
          <OpportunityCards spreads={allPairs} capital={capital} leverage={leverage} />

          {/* ── Advanced / full data ──────────────────────────────────── */}
          <div className="border border-border mb-5">
            <button
              onClick={() => setShowAdvanced(v => !v)}
              className="w-full px-4 py-3 flex items-center justify-between font-mono text-[10px] text-text-muted hover:text-text-primary hover:bg-bg-elevated/20 transition-colors duration-100"
            >
              <span className="uppercase tracking-widest">Advanced / full data</span>
              <span className="text-text-muted/50">{showAdvanced ? 'collapse ↑' : `${allPairs.length} pairs · expand ↓`}</span>
            </button>

            {showAdvanced && (
              <div className="border-t border-border">

                {/* Status counters + timers */}
                <div className="px-4 py-3 border-b border-border/40 flex flex-wrap gap-2 items-center">
                  {[
                    { label: 'HARVEST',  val: harvestPairs.length, cls: 'text-positive border-positive/30' },
                    { label: 'CAUTION',  val: cautionPairs.length, cls: 'text-warning border-warning/30'   },
                    {
                      label: 'MARGINAL',
                      val:   allPairs.length - harvestPairs.length - cautionPairs.length,
                      cls:   'text-text-muted border-border opacity-50',
                    },
                    { label: 'CEX↔DEX', val: dexPairs.length,  cls: 'text-accent border-accent/30'      },
                    { label: 'TOTAL',   val: allPairs.length,  cls: 'text-text-secondary border-border'  },
                  ].map(({ label, val, cls }) => (
                    <div key={label} className={`px-2.5 py-1 border font-mono text-[10px] ${cls}`}>
                      <span className="text-[11px] font-bold tabular-nums mr-1">{val}</span>
                      {label}
                    </div>
                  ))}

                  {bestDayUsd !== null ? (
                    <div className="px-2.5 py-1 border border-positive/30 font-mono text-[10px] text-positive">
                      Best: <span className="font-bold">{fmtDayUsd(bestDayUsd)}</span>
                      <span className="text-[9px] text-positive/50 ml-1">on ${capital.toLocaleString()}</span>
                    </div>
                  ) : allPairs.length > 0 ? (
                    <div className="px-2.5 py-1 border border-positive/30 font-mono text-[10px] text-positive"
                      title="Theoretical ceiling — rate changes hourly.">
                      Best ceiling: <span className="font-bold">{fmtApy(allPairs[0].netApy30d)}</span>
                    </div>
                  ) : null}

                  {/* Reset timers */}
                  <div className="ml-auto flex gap-4 shrink-0">
                    {cexNextMs != null && (
                      <span className="font-mono text-[9px] text-text-muted">
                        CEX next: <span className="text-text-primary"><FundingCountdown targetMs={cexNextMs} /></span>
                      </span>
                    )}
                    {hlNextMs != null && (
                      <span className="font-mono text-[9px] text-text-muted">
                        HL next: <span className="text-accent"><FundingCountdown targetMs={hlNextMs} /></span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Full spread table */}
                <div id="funding-spreads" className="scroll-mt-16">
                  <div className="px-4 py-2 border-b border-border/40 flex items-center justify-between">
                    <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted">
                      All Pairs
                    </span>
                    <span className="font-mono text-[9px] text-text-muted">
                      {allPairs.length} pairs · ranked by net yield (30d)
                    </span>
                  </div>
                  <SpreadTable spreads={allPairs} meta={data.meta} capital={capital} leverage={leverage} />
                  <div className="px-4 pb-3">
                    <FeeNote meta={data.meta} />
                  </div>
                </div>

                {/* Per-exchange rate heatmap */}
                <div className="border-t border-border">
                  <div className="px-4 py-2 border-b border-border/40 flex items-center justify-between flex-wrap gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted">
                      Per-Exchange Funding Rates
                    </span>
                    <span className="font-mono text-[9px] text-text-muted">
                      Positive → shorts collect · Negative → longs collect ·{' '}
                      <span className="text-accent">DEX = Hyperliquid (1h)</span>
                    </span>
                  </div>
                  <RateHeatmap futures={data.futures} />
                  <div className="px-4 py-2 border-t border-border/40 flex flex-wrap gap-x-6 gap-y-0.5">
                    <span className="font-mono text-[9px] text-text-muted">
                      CEX next reset: <span className="text-text-primary"><FundingCountdown targetMs={cexNextMs} /></span>
                      <span className="ml-2 text-text-muted/50">(00:00, 08:00, 16:00 UTC)</span>
                    </span>
                    {data.futures.hyperliquid && (
                      <span className="font-mono text-[9px] text-text-muted">
                        HL next reset: <span className="text-accent"><FundingCountdown targetMs={hlNextMs} /></span>
                        <span className="ml-2 text-text-muted/50">(every UTC hour)</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Spot prices */}
                {Object.keys(data.spot.binance ?? {}).length > 0 && (
                  <div className="border-t border-border">
                    <div className="px-4 py-2 border-b border-border/40">
                      <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted">Spot Prices (Binance)</span>
                    </div>
                    <div className="flex flex-wrap gap-px">
                      {Object.entries(data.spot.binance).map(([coin, s]) => (
                        <div key={coin} className="flex-1 min-w-[110px] px-4 py-3 border-r border-border/50 last:border-0">
                          <div className="font-mono text-[10px] text-text-muted mb-1">{coin}/USDT</div>
                          <div className="font-mono text-[13px] text-text-primary tabular-nums">
                            ${s.price.toLocaleString(undefined, { maximumFractionDigits: s.price > 1 ? 2 : 5 })}
                          </div>
                          {s.change24hPct != null && (
                            <div className={`font-mono text-[10px] tabular-nums mt-0.5 ${s.change24hPct >= 0 ? 'text-positive' : 'text-negative'}`}>
                              {s.change24hPct >= 0 ? '+' : ''}{s.change24hPct.toFixed(2)}%
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* CEX spot arbitrage */}
                <div className="border-t border-border">
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
