'use client';

import { useEffect, useState, useCallback, Fragment } from 'react';

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
}

interface SpotCoin {
  price:         number;
  change24hPct?: number;
}

interface Meta {
  feePerLeg:    { cex: number; dex: number };
  legCount:     number;
  periodsPerYr: { cex: number; hl: number };
  note:         string;
}

interface ApiResponse {
  ok:           boolean;
  generatedAt:  number | null;
  staleMinutes: number | null;
  futures:      Record<string, Record<string, FuturesCoin>>;
  spot:         Record<string, Record<string, SpotCoin>>;
  spreads:      SpreadItem[];
  meta:         Meta | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRate(fr: number, intervalHours?: number): string {
  const sign = fr >= 0 ? '+' : '';
  const suffix = intervalHours === 1 ? '/hr' : '/8h';
  return `${sign}${fr.toFixed(4)}%${suffix}`;
}

function fmtApy(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%/yr`;
}

function rateCls(fr: number): string {
  if (fr > 0.005) return 'text-positive font-medium';
  if (fr > 0)     return 'text-positive/70';
  if (fr < 0)     return 'text-negative/80';
  return 'text-text-muted';
}

function statusBadgeCls(s: string): string {
  if (s === 'HARVEST')  return 'bg-positive/10 text-positive border-positive/25';
  if (s === 'CAUTION')  return 'bg-warning/10 text-warning border-warning/25';
  return 'bg-negative/10 text-negative/70 border-negative/25';
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function venueLabel(exchange: string, isDex: boolean): string {
  return isDex ? `${cap(exchange)} (DEX)` : cap(exchange);
}

// ── Sizing helpers ────────────────────────────────────────────────────────────

type Leverage = 1 | 2 | 3 | 5;
const LEVERAGE_OPTIONS: Leverage[] = [1, 2, 3, 5];

function fmtUsd(n: number): string {
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  if (abs >= 100)    return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function calcSpreadSizing(s: SpreadItem, capital: number, leverage: Leverage) {
  const N         = capital * leverage / 2;
  const feesUsd   = N * s.totalFeesPct / 100;
  const net30dUsd = N * s.grossApy / 100 * 30 / 365 - feesUsd;
  const netYrUsd  = N * s.netApy30d / 100;
  const roc       = capital > 0 ? netYrUsd / capital * 100 : 0;
  return { N, feesUsd, net30dUsd, netYrUsd, roc };
}

// ── Funding countdown ─────────────────────────────────────────────────────────

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

// ── Sub-components ────────────────────────────────────────────────────────────

function VariabilityBanner({
  cexNextMs, hlNextMs,
}: { cexNextMs: number | null; hlNextMs: number | null }) {
  return (
    <div className="border border-warning/30 bg-warning/5 px-4 py-2.5 mb-5 flex flex-wrap items-center gap-x-6 gap-y-1.5">
      <span className="font-mono text-[10px] uppercase tracking-widest text-warning shrink-0">
        HARVEST · variable rate
      </span>
      <span className="font-mono text-[10px] text-text-secondary">
        APYs project the CURRENT rate — not locked. CEX resets every 8h. Hyperliquid resets HOURLY.
      </span>
      <div className="ml-auto flex gap-6 shrink-0">
        {cexNextMs != null && (
          <span className="font-mono text-[10px] text-text-muted">
            CEX next: <span className="text-text-primary"><FundingCountdown targetMs={cexNextMs} /></span>
          </span>
        )}
        {hlNextMs != null && (
          <span className="font-mono text-[10px] text-text-muted">
            HL next: <span className="text-accent"><FundingCountdown targetMs={hlNextMs} /></span>
          </span>
        )}
      </div>
    </div>
  );
}

function FeeNote({ meta }: { meta: Meta | null }) {
  if (!meta) return null;
  return (
    <p className="font-mono text-[9px] text-text-muted mt-1.5 leading-relaxed">
      Fee assumption: CEX {meta.feePerLeg.cex}%/leg · Hyperliquid (DEX) {meta.feePerLeg.dex}%/leg.
      Round-trip = open + close both sides (4 legs). NET 30d = gross spread × 30d − fees, annualized.
      MARGINAL = &gt;10d breakeven · CAUTION = &gt;5d · HARVEST = ≤5d.
    </p>
  );
}

function SpreadTable({
  spreads, meta, capital, leverage, setCapital, setLeverage,
}: {
  spreads: SpreadItem[];
  meta: Meta | null;
  capital: number;
  leverage: Leverage;
  setCapital: (n: number) => void;
  setLeverage: (n: Leverage) => void;
}) {
  const N = capital * leverage / 2;

  return (
    <div>
      {/* Sizing control */}
      <div className="px-4 py-2 border-b border-border/40 flex flex-wrap items-center gap-x-4 gap-y-1 bg-bg-elevated/10">
        <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted shrink-0">
          Capital
        </span>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] text-text-muted">$</span>
          <input
            type="number"
            min={0}
            step={100}
            value={capital}
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
        {capital > 0 && (
          <>
            <span className="font-mono text-[9px] text-text-muted">
              N/leg: <span className="text-text-secondary tabular-nums">{fmtUsd(N)}</span>
            </span>
            {leverage > 1 && (
              <span className="font-mono text-[9px] text-warning/70">LIQUIDATION risk at {leverage}×</span>
            )}
          </>
        )}
        <span className="font-mono text-[9px] text-text-muted/40 ml-auto hidden sm:block">
          ROC = net$/yr ÷ capital · projected, not locked
        </span>
      </div>

      {/* Table */}
      {spreads.length === 0 ? (
        <div className="py-8 text-center font-mono text-[10px] text-text-muted">
          No pairs in current data.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[11px] border-collapse">
            <thead>
              <tr className="border-b border-border">
                {['COIN', 'SHORT (collect)', 'LONG (pay)', 'GROSS APY', 'FEES', 'BREAKEVEN', 'NET 30d APY', 'STATUS'].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spreads.map(s => {
                const key       = `${s.coin}-${s.shortExchange}-${s.longExchange}`;
                const isMarginal = s.status === 'MARGINAL';
                const sz        = capital > 0 ? calcSpreadSizing(s, capital, leverage) : null;
                return (
                  <Fragment key={key}>
                    <tr className={`border-b ${sz ? 'border-border/20' : 'border-border/50'} hover:bg-bg-elevated/40 transition-colors duration-100 ${isMarginal ? 'opacity-50' : ''}`}>
                      <td className="px-3 py-2.5 font-semibold text-text-primary">{s.coin}</td>

                      {/* SHORT leg */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={`text-text-secondary ${s.shortIsDex ? 'text-accent' : ''}`}>
                          {venueLabel(s.shortExchange, s.shortIsDex)}
                        </span>
                        <span className="text-border mx-1">·</span>
                        <span className={rateCls(s.frShort)}>
                          {fmtRate(s.frShort, s.intervalHoursShort)}
                        </span>
                      </td>

                      {/* LONG leg */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={`text-text-secondary ${s.longIsDex ? 'text-accent' : ''}`}>
                          {venueLabel(s.longExchange, s.longIsDex)}
                        </span>
                        <span className="text-border mx-1">·</span>
                        <span className={rateCls(s.frLong)}>
                          {fmtRate(s.frLong, s.intervalHoursLong)}
                        </span>
                      </td>

                      <td className="px-3 py-2.5 tabular-nums font-semibold text-positive">
                        {fmtApy(s.grossApy)}
                      </td>

                      <td className="px-3 py-2.5 tabular-nums text-text-muted text-[10px] whitespace-nowrap">
                        {s.totalFeesPct.toFixed(2)}%
                        {s.hasDexLeg && <span className="text-accent ml-1">†</span>}
                      </td>

                      <td className="px-3 py-2.5 tabular-nums text-text-secondary whitespace-nowrap">
                        {s.breakevenDays}d
                      </td>

                      <td className={`px-3 py-2.5 tabular-nums font-semibold ${s.netApy30d > 0 ? 'text-positive' : 'text-negative/70'}`}>
                        {fmtApy(s.netApy30d)}
                      </td>

                      <td className="px-3 py-2.5">
                        <span className={`px-1.5 py-[2px] border text-[9px] uppercase tracking-widest ${statusBadgeCls(s.status)}`}>
                          {s.status}
                        </span>
                      </td>
                    </tr>

                    {sz && (
                      <tr className="border-b border-border/50 bg-bg-elevated/10">
                        <td colSpan={8} className="px-3 py-1.5">
                          <div className="flex flex-wrap gap-x-4 font-mono text-[10px]">
                            <span className="text-text-muted">
                              N/leg <span className="text-text-primary tabular-nums">{fmtUsd(sz.N)}</span>
                            </span>
                            <span className="text-text-muted">
                              Fees <span className="text-text-primary tabular-nums">{fmtUsd(sz.feesUsd)}</span>
                            </span>
                            <span className="text-text-muted">
                              Net 30d{' '}
                              <span className={`tabular-nums ${sz.net30dUsd >= 0 ? 'text-positive' : 'text-negative'}`}>
                                {fmtUsd(sz.net30dUsd)}
                              </span>
                            </span>
                            <span className="text-text-muted">
                              Net/yr{' '}
                              <span className={`tabular-nums ${sz.netYrUsd >= 0 ? 'text-positive' : 'text-negative'}`}>
                                {fmtUsd(sz.netYrUsd)}
                              </span>
                            </span>
                            <span className="ml-auto text-text-muted">
                              ROC{' '}
                              <span className={`tabular-nums font-semibold ${sz.roc >= 0 ? 'text-positive' : 'text-negative'}`}>
                                {sz.roc >= 0 ? '+' : ''}{sz.roc.toFixed(1)}%/yr
                              </span>
                            </span>
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
            <div className="px-3 pb-2 pt-1 font-mono text-[9px] text-accent/70">
              † DEX leg (Hyperliquid): {meta?.feePerLeg.dex ?? 0.025}%/leg taker fee.
              Bridge friction: ~10 min + ~$1–5 ETH gas one-time to deposit USDC.
              HL funds HOURLY — this leg can flip every hour.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RateHeatmap({ futures }: { futures: Record<string, Record<string, FuturesCoin>> }) {
  const CEX_ORDER    = ['binance', 'bybit', 'okx'];
  const DEX_ORDER    = ['hyperliquid'];
  const allExchanges = [
    ...CEX_ORDER.filter(e => futures[e]),
    ...DEX_ORDER.filter(e => futures[e]),
  ];
  if (allExchanges.length === 0) return null;

  const coinSet: Record<string, true> = {};
  for (const coins of Object.values(futures)) {
    for (const c of Object.keys(coins)) coinSet[c] = true;
  }
  const allCoins  = Object.keys(coinSet);
  const COIN_ORDER = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'];
  const coins = [
    ...COIN_ORDER.filter(c => coinSet[c]),
    ...allCoins.filter(c => !COIN_ORDER.includes(c)).sort(),
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px] border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal">COIN</th>
            {allExchanges.map(ex => (
              <th key={ex} className={`px-3 py-2 text-left text-[9px] uppercase tracking-widest font-normal whitespace-nowrap ${ex === 'hyperliquid' ? 'text-accent' : 'text-text-muted'}`}>
                {cap(ex)}{ex === 'hyperliquid' ? ' (DEX)' : ''}
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
                if (!data) {
                  return <td key={ex} className="px-3 py-2.5 text-text-muted/30 text-[10px]">—</td>;
                }
                const isHl = ex === 'hyperliquid';
                return (
                  <td key={ex} className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                    <span className={rateCls(data.fundingRate)}>
                      {fmtRate(data.fundingRate, data.fundingIntervalHours)}
                    </span>
                    {data.markPrice != null && (
                      <span className="ml-2 text-text-muted text-[9px]">
                        ${data.markPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                    )}
                    {isHl && (
                      <span className="ml-1 text-[8px] text-accent/60">1h</span>
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CryptoPage() {
  const [data,     setData]     = useState<ApiResponse | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [capital,  setCapital]  = useState(1000);
  const [leverage, setLeverage] = useState<Leverage>(1);

  const load = useCallback(async () => {
    try {
      const res  = await fetch('/api/crypto', { cache: 'no-store' });
      const json: ApiResponse = await res.json();
      setData(json);
    } catch { /* keep stale on transient error */ }
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
  const harvestPairs = data?.spreads.filter(s => s.status === 'HARVEST')  ?? [];
  const cautionPairs = data?.spreads.filter(s => s.status === 'CAUTION')  ?? [];
  const allPairs     = data?.spreads ?? [];
  const dexPairs     = allPairs.filter(s => s.hasDexLeg);

  return (
    <div className="max-w-[1200px] mx-auto px-4 py-6">

      {/* Header */}
      <div className="mb-5 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <div>
          <h1 className="font-mono text-sm uppercase tracking-widest text-text-primary">
            FUNDING RATE MONITOR
          </h1>
          <p className="font-mono text-[10px] text-text-muted mt-0.5">
            CROSS-EXCHANGE SPREAD ARB · BINANCE / BYBIT / OKX · HYPERLIQUID (DEX)
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
          <VariabilityBanner cexNextMs={cexNextMs} hlNextMs={hlNextMs} />

          {/* Summary chips */}
          <div className="flex flex-wrap gap-2 mb-5">
            {[
              { label: 'HARVEST',  val: harvestPairs.length, cls: 'text-positive border-positive/30' },
              { label: 'CAUTION',  val: cautionPairs.length, cls: 'text-warning border-warning/30'   },
              { label: 'MARGINAL', val: allPairs.length - harvestPairs.length - cautionPairs.length, cls: 'text-text-muted border-border opacity-50' },
              { label: 'CEX↔DEX', val: dexPairs.length, cls: 'text-accent border-accent/30' },
              { label: 'TOTAL',    val: allPairs.length, cls: 'text-text-secondary border-border' },
            ].map(({ label, val, cls }) => (
              <div key={label} className={`px-3 py-1.5 border font-mono text-[10px] ${cls}`}>
                <span className="text-[12px] font-bold tabular-nums mr-1.5">{val}</span>
                {label}
              </div>
            ))}
            {allPairs.length > 0 && (
              <div className="px-3 py-1.5 border border-positive/30 font-mono text-[10px] text-positive ml-auto">
                Best gross: <span className="font-bold">{fmtApy(allPairs[0].grossApy)}</span>
              </div>
            )}
          </div>

          {/* Section 1: Spread opportunities */}
          <div className="bg-bg-panel border border-border mb-5">
            <div className="px-4 py-2 border-b border-border flex items-center justify-between flex-wrap gap-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
                Cross-Exchange Spread Opportunities
              </span>
              <span className="font-mono text-[9px] text-text-muted">
                SHORT collect-side · LONG pay-side · delta-neutral · gross of fees
              </span>
            </div>
            <SpreadTable
              spreads={allPairs}
              meta={data.meta}
              capital={capital}
              leverage={leverage}
              setCapital={setCapital}
              setLeverage={setLeverage}
            />
            <div className="px-4 pb-3">
              <FeeNote meta={data.meta} />
            </div>
          </div>

          {/* Section 2: Per-exchange rate heatmap */}
          <div className="bg-bg-panel border border-border mb-5">
            <div className="px-4 py-2 border-b border-border flex items-center justify-between flex-wrap gap-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
                Per-Exchange Funding Rates
              </span>
              <span className="font-mono text-[9px] text-text-muted">
                Positive → shorts collect · Negative → longs collect · <span className="text-accent">DEX = Hyperliquid (1h intervals)</span>
              </span>
            </div>
            <RateHeatmap futures={data.futures} />
            <div className="px-4 py-2 border-t border-border flex flex-wrap gap-x-6 gap-y-0.5">
              <span className="font-mono text-[9px] text-text-muted">
                CEX next reset: <span className="text-text-primary"><FundingCountdown targetMs={cexNextMs} /></span>
                <span className="ml-2 text-text-muted/50">(Bin/Bybit/OKX at 00:00, 08:00, 16:00 UTC)</span>
              </span>
              {data.futures.hyperliquid && (
                <span className="font-mono text-[9px] text-text-muted">
                  HL next reset: <span className="text-accent"><FundingCountdown targetMs={hlNextMs} /></span>
                  <span className="ml-2 text-text-muted/50">(every UTC hour)</span>
                </span>
              )}
            </div>
          </div>

          {/* Section 3: Spot price strip */}
          {Object.keys(data.spot.binance ?? {}).length > 0 && (
            <div className="bg-bg-panel border border-border">
              <div className="px-4 py-2 border-b border-border">
                <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
                  Spot Prices (Binance)
                </span>
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
        </>
      )}
    </div>
  );
}
