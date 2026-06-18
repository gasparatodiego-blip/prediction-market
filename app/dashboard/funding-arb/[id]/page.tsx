'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FuturesCoin {
  markPrice?:             number | null;
  fundingRate:            number;
  fundingIntervalHours?:  number;
  nextFundingTime?:       number;
  openInterest?:          number | null;
  openInterestUsd?:       number | null;
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

interface ApiResponse {
  ok:           boolean;
  futures:      Record<string, Record<string, FuturesCoin>>;
  spreads:      SpreadItem[];
  staleMinutes: number | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

type Leverage = 1 | 2 | 3 | 5;
const LEVERAGE_OPTIONS: Leverage[] = [1, 2, 3, 5];

// ── Fee helpers (mirrors lib/funding-math.js — taker fees per leg) ────────────
// Kept in sync manually; single source of truth is lib/funding-math.js

function takerFeePct(exchange: string): number {
  if (exchange === 'hyperliquid') return 0.025;
  if (exchange === 'dydx')        return 0.05;
  if (exchange === 'gateio')      return 0.05;
  if (exchange === 'bitget')      return 0.06;
  return 0.04; // Binance / Bybit / OKX
}

// Typical maker fees per leg (illustrative only — verify on each exchange)
function makerFeePct(exchange: string): number {
  if (exchange === 'hyperliquid') return 0;    // HL maker rebate = 0% (may be positive)
  if (exchange === 'dydx')        return 0.02;
  if (exchange === 'gateio')      return 0.02;
  if (exchange === 'bitget')      return 0.02;
  return 0.02; // Binance / Bybit / OKX typical maker
}

// ── Display helpers ───────────────────────────────────────────────────────────

function venueLabel(e: string): string {
  if (e === 'dydx')        return 'dYdX';
  if (e === 'hyperliquid') return 'Hyperliquid';
  if (e === 'gateio')      return 'Gate.io';
  if (e === 'bitget')      return 'Bitget';
  return e.charAt(0).toUpperCase() + e.slice(1).toLowerCase();
}

function fmtApy(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%/yr`;
}

function fmtUsd(n: number): string {
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  if (abs >= 100)    return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtQty(n: number): string {
  if (n >= 1_000) return n.toFixed(2);
  if (n >= 1)     return n.toFixed(4);
  return n.toFixed(6);
}

function fmtRate(fr: number, intervalHours: number): string {
  const sign   = fr >= 0 ? '+' : '';
  const suffix = intervalHours === 1 ? '/hr' : '/8h';
  return `${sign}${fr.toFixed(4)}%${suffix}`;
}

function intervalLabel(h: number): string {
  return h === 1 ? 'every hour (UTC)' : 'every 8h (00:00, 08:00, 16:00 UTC)';
}

function settlementCurrency(exchange: string): string {
  return exchange === 'hyperliquid' || exchange === 'dydx' ? 'USDC' : 'USDT';
}

function statusBadgeCls(s: string): string {
  if (s === 'HARVEST') return 'bg-positive/10 text-positive border-positive/25';
  if (s === 'CAUTION') return 'bg-warning/10 text-warning border-warning/25';
  return 'bg-negative/10 text-negative/70 border-negative/25';
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StepLabel({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <span className="font-mono text-[9px] px-1.5 py-[2px] border border-border text-text-muted shrink-0 mt-0.5">
        {String(n).padStart(2, '0')}
      </span>
      <span className="font-mono text-[11px] text-text-secondary font-medium">{text}</span>
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <h2 className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-3 mt-6 border-b border-border/30 pb-1.5">
      {title}
    </h2>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FundingArbDetailPage({ params }: { params: { id: string } }) {
  const parts         = params.id.split('-');
  const coin          = parts[0]?.toUpperCase() ?? '';
  const shortExchange = parts[1] ?? '';
  const longExchange  = parts[2] ?? '';

  const [data,           setData]           = useState<ApiResponse | null>(null);
  const [loading,        setLoading]        = useState(true);
  const [capital,        setCapital]        = useState(1000);
  const [leverage,       setLeverage]       = useState<Leverage>(1);
  const [alertThreshold, setAlertThreshold] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res  = await fetch('/api/crypto', { cache: 'no-store' });
      const json = await res.json();
      setData(json);
    } catch { /* keep stale */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const spread = data?.spreads?.find(
    s => s.coin === coin && s.shortExchange === shortExchange && s.longExchange === longExchange
  ) ?? null;

  const shortMark = data?.futures?.[shortExchange]?.[coin]?.markPrice ?? null;
  const longMark  = data?.futures?.[longExchange]?.[coin]?.markPrice  ?? null;
  const markPrice = shortMark ?? longMark;

  // Sizing
  const notionalPerLeg = capital * leverage / 2;
  const qty            = markPrice != null && markPrice > 0
    ? notionalPerLeg / markPrice
    : null;

  // P&L estimates
  const netYrUsd  = spread ? notionalPerLeg * spread.netApy30d / 100 : null;
  const dayUsd    = netYrUsd != null ? netYrUsd / 365 : null;
  const feesUsd   = spread ? notionalPerLeg * spread.totalFeesPct / 100 : null;
  const net30dUsd = (netYrUsd != null && feesUsd != null && spread)
    ? notionalPerLeg * spread.grossApy / 100 * 30 / 365 - feesUsd
    : null;

  // Per-leg fee breakdown (taker)
  const shortTakerPct  = takerFeePct(shortExchange);
  const longTakerPct   = takerFeePct(longExchange);
  const shortMakerPct  = makerFeePct(shortExchange);
  const longMakerPct   = makerFeePct(longExchange);
  const makerTotalPct  = (shortMakerPct + longMakerPct) * 2;
  const makerSavingPct = spread ? spread.totalFeesPct - makerTotalPct : 0;
  const makerSavingUsd = capital > 0 ? notionalPerLeg * makerSavingPct / 100 : 0;

  // Breakeven expressed in funding intervals
  const beShortIntervals = spread
    ? Math.ceil(spread.breakevenDays * 24 / spread.intervalHoursShort)
    : 0;
  const beLongIntervals  = spread
    ? Math.ceil(spread.breakevenDays * 24 / spread.intervalHoursLong)
    : 0;

  // MARGINAL boundary — gross spread below which fees take >10d to recover
  const marginalBoundary = spread ? +(spread.totalFeesPct * 36.5).toFixed(1) : 5;

  // Threshold alert — default to MARGINAL boundary
  const effectiveThreshold = alertThreshold ?? marginalBoundary;
  const tgFollowHref       = `https://t.me/Gaspola_bot?start=fund_${coin}`;
  const tgAlertHref        = `https://t.me/Gaspola_bot?start=fund_${coin}_exit_${Math.round(effectiveThreshold * 10)}`;

  return (
    <div className="max-w-[860px] mx-auto px-4 py-6">

      {/* Back nav */}
      <div className="mb-5">
        <Link
          href="/dashboard/funding-arb"
          className="font-mono text-[10px] text-text-muted hover:text-text-primary transition-colors duration-100"
        >
          ← Back to Funding Rate Monitor
        </Link>
      </div>

      {loading ? (
        <div className="py-20 text-center font-mono text-[10px] uppercase tracking-widest text-text-muted animate-pulse">
          Loading…
        </div>
      ) : !data?.ok ? (
        <div className="py-20 text-center font-mono text-[10px] text-negative">
          Data unavailable — agent not running.
        </div>
      ) : !spread ? (
        <div className="py-20 text-center space-y-2">
          <div className="font-mono text-[11px] text-text-muted">
            Opportunity not found: {coin} · {shortExchange} / {longExchange}
          </div>
          <div className="font-mono text-[9px] text-text-muted/50">
            This pair may have dropped out of the current snapshot — check the main list.
          </div>
          <div className="mt-4">
            <Link href="/dashboard/funding-arb" className="font-mono text-[10px] text-accent">
              ← Return to list
            </Link>
          </div>
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <h1 className="font-mono text-[22px] font-bold text-text-primary">{coin}</h1>
                <span className={`px-1.5 py-[2px] border text-[9px] font-mono uppercase tracking-widest ${statusBadgeCls(spread.status)}`}>
                  {spread.status}
                </span>
                {spread.thinFlag && (
                  <span className="font-mono text-[9px] text-warning">⚠ thin liquidity</span>
                )}
              </div>
              <p className="font-mono text-[11px] text-text-muted">
                Short {venueLabel(shortExchange)}{spread.shortIsDex ? ' (DEX)' : ''} ·{' '}
                Long {venueLabel(longExchange)}{spread.longIsDex ? ' (DEX)' : ''}
              </p>
              <p className="font-mono text-[9px] text-text-muted/60 mt-1">
                Perp / Perp · both legs are perpetual futures · no spot leg
              </p>
            </div>
            <a
              href={tgFollowHref}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[10px] px-3 py-1.5 border border-accent/30 text-accent/70 hover:border-accent hover:text-accent transition-colors duration-100 whitespace-nowrap"
            >
              ✈ Follow {coin} on Telegram
            </a>
          </div>

          {/* Current rates snapshot */}
          <div className="mb-5 px-4 py-3 bg-bg-panel border border-border font-mono text-[11px]">
            <div className="text-[9px] uppercase tracking-widest text-text-muted mb-2">Live rates (current snapshot)</div>
            <div className="flex flex-wrap gap-x-8 gap-y-1.5">
              <span>
                <span className="text-text-muted">Short {venueLabel(shortExchange)}: </span>
                <span className="text-positive font-medium tabular-nums">collect {fmtRate(spread.frShort, spread.intervalHoursShort)}</span>
              </span>
              <span>
                <span className="text-text-muted">Long {venueLabel(longExchange)}: </span>
                <span className={spread.frLong <= 0 ? 'text-positive font-medium' : 'text-negative/80 font-medium'}>
                  {spread.frLong <= 0 ? 'collect' : 'pay'} {fmtRate(Math.abs(spread.frLong), spread.intervalHoursLong)}
                </span>
              </span>
              <span>
                <span className="text-text-muted">Gross spread: </span>
                <span className="text-text-primary tabular-nums">{fmtApy(spread.grossApy)}</span>
              </span>
              <span>
                <span className="text-text-muted">Net (30d proj): </span>
                <span className={`tabular-nums font-medium ${spread.netApy30d > 0 ? 'text-positive' : 'text-negative'}`}>
                  {fmtApy(spread.netApy30d)}
                </span>
              </span>
            </div>
            {data.staleMinutes != null && data.staleMinutes > 5 && (
              <div className="mt-2 text-[9px] text-warning">Data is {data.staleMinutes}m old — rates may have shifted.</div>
            )}
          </div>

          {/* Capital & leverage input */}
          <div className="mb-5 px-4 py-3 bg-bg-panel border border-border">
            <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-2">Your capital</div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-1">
                <span className="font-mono text-[10px] text-text-muted">$</span>
                <input
                  type="number" min={0} step={100} value={capital}
                  onChange={e => setCapital(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-[5rem] px-1.5 py-0.5 font-mono text-[11px] bg-bg-panel border border-border text-text-primary focus:border-accent/50 focus:outline-none tabular-nums"
                />
              </div>
              <div className="flex items-center gap-1">
                {LEVERAGE_OPTIONS.map(lev => (
                  <button
                    key={lev}
                    onClick={() => setLeverage(lev)}
                    title={lev === 1
                      ? '1× — no leverage; each leg sized to half capital. No liquidation risk from basis moves.'
                      : `${lev}× — both legs use ${lev}× margin. Notional/leg = capital × ${lev} / 2. Higher yield, higher liquidation risk.`
                    }
                    className={`px-1.5 py-0.5 font-mono text-[10px] border transition-colors duration-100 cursor-help ${
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
                <span className="font-mono text-[9px] text-warning/70">
                  {leverage}× applied to both perp legs — liquidation risk if basis widens
                </span>
              )}
            </div>
          </div>

          {/* Sizing + fee breakdown */}
          {capital > 0 && (
            <div className="mb-6 px-4 py-4 border border-positive/25 bg-positive/5">

              <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-2">
                Estimated outcome at ${capital.toLocaleString()}{leverage > 1 ? ` · ${leverage}×` : ''}
              </div>

              {/* Key metrics row */}
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 font-mono text-[11px] mb-4">
                <span>
                  <span className="text-text-muted">Notional/leg: </span>
                  <span className="text-text-primary tabular-nums font-medium">{fmtUsd(notionalPerLeg)}</span>
                </span>
                {qty != null && markPrice != null && (
                  <span>
                    <span className="text-text-muted">Qty: </span>
                    <span className="text-text-primary tabular-nums font-medium">{fmtQty(qty)} {coin}</span>
                    <span className="text-text-muted/50 text-[9px] ml-1">@ ${markPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  </span>
                )}
                {dayUsd != null && (
                  <span>
                    <span className="text-positive font-bold text-[14px] tabular-nums">{fmtUsd(dayUsd)}/day</span>
                    <span className="text-text-muted/50 text-[9px] ml-1">(net, annualized at current rate)</span>
                  </span>
                )}
                {net30dUsd != null && (
                  <span>
                    <span className="text-text-muted">Net 30d: </span>
                    <span className={`tabular-nums font-medium ${net30dUsd >= 0 ? 'text-positive' : 'text-negative'}`}>
                      {fmtUsd(net30dUsd)}
                    </span>
                    <span className="text-text-muted/50 text-[9px] ml-1">(if rate holds 30d)</span>
                  </span>
                )}
              </div>

              {/* Fee breakdown */}
              <div className="border-t border-border/30 pt-3">
                <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-2">
                  Fee breakdown — taker fills assumed · full round-trip (4 legs)
                </div>

                <div className="space-y-[3px] font-mono text-[10px]">
                  {([
                    ['Open  SHORT', shortExchange, shortTakerPct],
                    ['Open  LONG ', longExchange,  longTakerPct],
                    ['Close SHORT', shortExchange, shortTakerPct],
                    ['Close LONG ', longExchange,  longTakerPct],
                  ] as [string, string, number][]).map(([action, ex, pct], i) => (
                    <div key={i} className="flex items-baseline gap-2">
                      <span className="text-text-muted w-[70px] shrink-0">{action}</span>
                      <span className="text-text-secondary w-[90px] shrink-0">{venueLabel(ex)}</span>
                      <span className="text-text-muted/60 tabular-nums w-[55px] shrink-0 text-[9px]">{pct}%/leg</span>
                      <span className="text-text-muted/50 text-[9px] shrink-0">×</span>
                      <span className="text-text-muted/60 tabular-nums text-[9px] shrink-0">{fmtUsd(notionalPerLeg)}</span>
                      <span className="text-text-muted/50 text-[9px] shrink-0">=</span>
                      <span className="tabular-nums text-negative/70 ml-auto">{fmtUsd(-(notionalPerLeg * pct / 100))}</span>
                    </div>
                  ))}
                  <div className="flex items-baseline gap-2 border-t border-border/30 pt-1.5 mt-1">
                    <span className="text-text-secondary font-medium">Total</span>
                    <span className="text-text-muted/50 text-[9px] ml-1">({spread.totalFeesPct.toFixed(3)}% of notional/leg)</span>
                    <span className="tabular-nums text-negative font-medium ml-auto">
                      {feesUsd != null ? fmtUsd(-feesUsd) : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between text-[9px] text-text-muted/60">
                    <span>Recovered in ≈{spread.breakevenDays}d at current rate</span>
                    <span>Already subtracted from net estimate above</span>
                  </div>
                </div>

                {/* Maker alternative */}
                <div className="mt-3 pt-2.5 border-t border-border/15 font-mono text-[9px] text-text-muted/70 leading-relaxed">
                  <span className="text-text-muted">Maker alternative: </span>
                  {shortExchange === 'hyperliquid'
                    ? `${venueLabel(shortExchange)} maker = 0%`
                    : `${venueLabel(shortExchange)} maker ≈ ${shortMakerPct}%/leg`
                  }
                  {' / '}
                  {longExchange === 'hyperliquid'
                    ? `${venueLabel(longExchange)} maker = 0%`
                    : `${venueLabel(longExchange)} maker ≈ ${longMakerPct}%/leg`
                  }
                  {makerSavingPct > 0.001 && (
                    <> — saves ≈{fmtUsd(makerSavingUsd)} vs taker on this capital.</>
                  )}
                  <span className="text-warning/70">
                    {' '}Risk: limit orders on two venues cannot be guaranteed to fill simultaneously.
                    A partial fill on one leg creates a one-sided directional position.
                    Use taker (market/IOC) to guarantee both fills close together.
                  </span>
                </div>
              </div>

              <p className="font-mono text-[9px] text-text-muted/50 mt-3 leading-relaxed">
                Estimates assume the current snapshot rate holds. Rate resets{' '}
                {intervalLabel(Math.min(spread.intervalHoursShort, spread.intervalHoursLong))} and can move in either direction.
                Treat all figures as an upper bound, not a guarantee.
              </p>
            </div>
          )}

          {/* Execution guide */}
          <SectionTitle title="Step-by-step execution guide" />
          <div className="space-y-0 mb-6">

            <div className="border-b border-border/20 pb-4 mb-4">
              <StepLabel n={1} text="Fund both exchange accounts" />
              <div className="ml-[42px] font-mono text-[10px] text-text-muted leading-relaxed space-y-1">
                <p>
                  Transfer {settlementCurrency(shortExchange)} to{' '}
                  <span className="text-text-secondary">{venueLabel(shortExchange)}</span>
                  {spread.shortIsDex ? ' (bridge from mainnet via USDC — allow ~10 min + gas)' : ''}.
                </p>
                <p>
                  Transfer {settlementCurrency(longExchange)} to{' '}
                  <span className="text-text-secondary">{venueLabel(longExchange)}</span>
                  {spread.longIsDex ? ' (bridge from mainnet via USDC — allow ~10 min + gas)' : ''}.
                </p>
                {capital > 0 && (
                  <p className="text-text-muted/70 mt-1">
                    Target: ≈{fmtUsd(notionalPerLeg)} margin on each side
                    {leverage > 1 ? ` (${leverage}× leverage — adjust margin to exchange minimum)` : ''}.
                  </p>
                )}
              </div>
            </div>

            <div className="border-b border-border/20 pb-4 mb-4">
              <StepLabel n={2} text={`Open SHORT on ${venueLabel(shortExchange)}`} />
              <div className="ml-[42px] font-mono text-[10px] text-text-muted leading-relaxed space-y-1">
                <p>
                  Instrument: <span className="text-text-secondary">{coin}-PERP</span> (USDT-margined perpetual)
                </p>
                <p>
                  Direction: <span className="text-negative/80 font-medium">SHORT</span>
                  {qty != null && (
                    <span> · <span className="tabular-nums">{fmtQty(qty)} {coin}</span></span>
                  )}
                  {capital > 0 && (
                    <span> · Notional: <span className="text-text-primary tabular-nums">{fmtUsd(notionalPerLeg)}</span></span>
                  )}
                </p>
                <p>
                  You will <span className="text-positive">collect</span> funding of{' '}
                  <span className="text-positive tabular-nums">{fmtRate(spread.frShort, spread.intervalHoursShort)}</span>{' '}
                  {intervalLabel(spread.intervalHoursShort)} in {settlementCurrency(shortExchange)}.
                </p>
                <p className="text-[9px] text-text-muted/60 border-l border-border/30 pl-2 mt-1">
                  <span className="text-text-muted">Fee assumption: </span>
                  taker {shortTakerPct}%/leg (used in net estimate above).
                  {shortExchange === 'hyperliquid'
                    ? ' Maker = 0% on HL — free if filled, but no fill guarantee.'
                    : ` Maker ≈${shortMakerPct}%/leg if filled — cheaper, but no simultaneous-fill guarantee with the other leg.`
                  }
                </p>
              </div>
            </div>

            <div className="border-b border-border/20 pb-4 mb-4">
              <StepLabel n={3} text={`Open LONG on ${venueLabel(longExchange)}`} />
              <div className="ml-[42px] font-mono text-[10px] text-text-muted leading-relaxed space-y-1">
                <p>
                  Instrument: <span className="text-text-secondary">{coin}-PERP</span> (USDT-margined perpetual)
                </p>
                <p>
                  Direction: <span className="text-positive/80 font-medium">LONG</span>
                  {qty != null && (
                    <span> · <span className="tabular-nums">{fmtQty(qty)} {coin}</span></span>
                  )}
                  {capital > 0 && (
                    <span> · Notional: <span className="text-text-primary tabular-nums">{fmtUsd(notionalPerLeg)}</span></span>
                  )}
                </p>
                <p>
                  {spread.frLong <= 0
                    ? <>Also <span className="text-positive">collect</span> funding of{' '}
                        <span className="text-positive tabular-nums">{fmtRate(Math.abs(spread.frLong), spread.intervalHoursLong)}</span> on this leg.</>
                    : <><span className="text-negative/80">Pay</span> funding of{' '}
                        <span className="text-negative/80 tabular-nums">{fmtRate(spread.frLong, spread.intervalHoursLong)}</span>{' '}
                        {intervalLabel(spread.intervalHoursLong)} in {settlementCurrency(longExchange)}.</>
                  }
                </p>
                <p className="text-[9px] text-text-muted/60 border-l border-border/30 pl-2 mt-1">
                  <span className="text-text-muted">Fee assumption: </span>
                  taker {longTakerPct}%/leg (used in net estimate above).
                  {longExchange === 'hyperliquid'
                    ? ' Maker = 0% on HL — free if filled, but no fill guarantee.'
                    : ` Maker ≈${longMakerPct}%/leg if filled — cheaper, but no simultaneous-fill guarantee.`
                  }
                </p>
              </div>
            </div>

            <div className="border-b border-border/20 pb-4 mb-4">
              <StepLabel n={4} text="Open both legs as simultaneously as possible" />
              <div className="ml-[42px] font-mono text-[10px] text-text-muted leading-relaxed">
                <p>
                  Between opening the first and second leg, {coin} price can move.
                  An unhedged leg is a directional bet.
                  At 1× the risk equals one tick × qty; at higher leverage the open notional is larger.
                  Minimize the time between fills — use two browser tabs or an automation if available.
                </p>
              </div>
            </div>

            <div className="border-b border-border/20 pb-4 mb-4">
              <StepLabel n={5} text="Monitor funding resets" />
              <div className="ml-[42px] font-mono text-[10px] text-text-muted leading-relaxed space-y-1.5">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  <span>
                    <span className="text-text-secondary">{venueLabel(shortExchange)}: </span>
                    {spread.intervalHoursShort === 1
                      ? `resets every hour — 24 payments/day in ${settlementCurrency(shortExchange)}`
                      : `resets 00:00 / 08:00 / 16:00 UTC — 3 payments/day in ${settlementCurrency(shortExchange)}`
                    }
                  </span>
                  <span>
                    <span className="text-text-secondary">{venueLabel(longExchange)}: </span>
                    {spread.intervalHoursLong === 1
                      ? `resets every hour — 24 payments/day in ${settlementCurrency(longExchange)}`
                      : `resets 00:00 / 08:00 / 16:00 UTC — 3 payments/day in ${settlementCurrency(longExchange)}`
                    }
                  </span>
                </div>
                <p className="text-text-muted/60">
                  Funding accrues directly to your margin balance — no action needed between resets.
                </p>
              </div>
            </div>

            <div className="border-b border-border/20 pb-4 mb-4">
              <StepLabel n={6} text="Exit: close both legs simultaneously" />
              <div className="ml-[42px] font-mono text-[10px] text-text-muted leading-relaxed space-y-1.5">

                {/* Breakeven box */}
                <div className="px-3 py-2 border border-warning/20 bg-warning/5 rounded-sm mb-2">
                  <p className="text-text-secondary font-medium text-[10px]">
                    Breakeven: hold for at least {spread.breakevenDays}d to recover round-trip fees
                  </p>
                  <p className="text-[9px] text-text-muted/80 mt-0.5">
                    = {beShortIntervals} {spread.intervalHoursShort === 1 ? 'hourly' : '8h'} intervals on {venueLabel(shortExchange)}
                    {beLongIntervals !== beShortIntervals && (
                      <> / {beLongIntervals} {spread.intervalHoursLong === 1 ? 'hourly' : '8h'} intervals on {venueLabel(longExchange)}</>
                    )}
                  </p>
                  <p className="text-[9px] text-warning/80 mt-1">
                    Exiting before {spread.breakevenDays}d means fees exceed what you&apos;ve earned — you lose money
                    even if every funding payment was positive.
                  </p>
                </div>

                <p className="text-text-muted">Close both legs when any trigger occurs:</p>
                <ul className="list-none space-y-0.5 ml-3 text-[9px]">
                  <li>· Gross spread drops below ≈{marginalBoundary.toFixed(1)}%/yr (MARGINAL boundary — fees take {'>'}10d to recover).</li>
                  <li>· Short-side rate flips negative — you begin paying instead of collecting.</li>
                  <li>· Net funding income on either interval is negative.</li>
                  <li>· Margin on either leg drops below your risk threshold.</li>
                </ul>
                <p className="text-[9px] text-text-muted/60 mt-1">
                  Use taker (market/IOC) on exit to guarantee fill — leg risk on close is identical to leg risk on open.
                  Close both legs within the same minute where possible.
                </p>
              </div>
            </div>

          </div>

          {/* When to exit — computed */}
          <SectionTitle title="Exit triggers — computed from current data" />
          <div className="mb-6 px-4 py-4 bg-bg-panel border border-border">

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-4 mb-4">
              <div>
                <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-1">Breakeven hold time</div>
                <div className="font-mono text-[18px] font-bold text-text-primary tabular-nums">{spread.breakevenDays}d</div>
                <div className="font-mono text-[9px] text-text-muted/70 mt-0.5 leading-relaxed">
                  {beShortIntervals} intervals ({spread.intervalHoursShort}h) on {venueLabel(shortExchange)}
                  {beLongIntervals !== beShortIntervals && (
                    <><br />{beLongIntervals} intervals ({spread.intervalHoursLong}h) on {venueLabel(longExchange)}</>
                  )}
                </div>
              </div>
              <div>
                <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-1">Exit at gross spread ≤</div>
                <div className="font-mono text-[18px] font-bold text-warning tabular-nums">{marginalBoundary.toFixed(1)}%/yr</div>
                <div className="font-mono text-[9px] text-text-muted/70 mt-0.5">
                  below this, fees take {'>'} 10d to recover
                </div>
              </div>
              <div>
                <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-1">Current gross spread</div>
                <div className={`font-mono text-[18px] font-bold tabular-nums ${spread.grossApy > marginalBoundary ? 'text-positive' : 'text-negative'}`}>
                  {fmtApy(spread.grossApy)}
                </div>
                <div className="font-mono text-[9px] text-text-muted/70 mt-0.5">
                  {spread.grossApy > marginalBoundary
                    ? `+${(spread.grossApy - marginalBoundary).toFixed(1)}%/yr above exit trigger`
                    : 'below exit trigger — consider closing'
                  }
                </div>
              </div>
            </div>

            <div className="border-t border-border/20 pt-3 font-mono text-[9px] text-text-muted leading-relaxed space-y-1.5">
              <p>
                <span className="text-text-secondary">Breakeven formula: </span>
                round-trip fees ({spread.totalFeesPct.toFixed(3)}%) ÷ gross spread ({spread.grossApy.toFixed(2)}%/yr) × 365 = {spread.breakevenDays}d
              </p>
              <p>
                <span className="text-text-secondary">MARGINAL boundary: </span>
                {spread.totalFeesPct.toFixed(3)}% × 36.5 = {marginalBoundary.toFixed(1)}%/yr — the gross spread at which breakeven extends past 10 days.
              </p>
              <p>
                <span className="text-text-secondary">Recommended exit when: </span>
                gross spread falls below {marginalBoundary.toFixed(1)}%/yr
                OR the short-leg rate flips sign
                OR basis risk / margin buffer is consumed.
              </p>
              <p className="text-text-muted/50 mt-1">
                Computed from current snapshot. Rate resets {intervalLabel(spread.intervalHoursShort === 1 ? 1 : 8)} — verify manually at each reset.
                These are mechanical triggers, not financial advice.
              </p>
            </div>
          </div>

          {/* Funding settlement detail */}
          <SectionTitle title="Funding settlement detail" />
          <div className="mb-6 px-4 py-3 bg-bg-panel border border-border font-mono text-[10px] text-text-muted leading-relaxed space-y-2">
            <p>
              All contracts are <span className="text-text-secondary">linear (USDT/USDC-margined) perpetuals</span>.
              No inverse (coin-margined) legs.
            </p>
            <p>
              <span className="text-text-secondary">{venueLabel(shortExchange)} short leg: </span>
              funding credited to you in <span className="text-text-primary">{settlementCurrency(shortExchange)}</span>,{' '}
              {spread.intervalHoursShort === 1 ? 'hourly' : 'every 8h'}.
              Rate: <span className="text-positive tabular-nums">{fmtRate(spread.frShort, spread.intervalHoursShort)}</span>.
            </p>
            <p>
              <span className="text-text-secondary">{venueLabel(longExchange)} long leg: </span>
              {spread.frLong >= 0
                ? <>funding <span className="text-negative/80">debited from you</span> in{' '}</>
                : <>funding <span className="text-positive">credited to you</span> in{' '}</>
              }
              <span className="text-text-primary">{settlementCurrency(longExchange)}</span>,{' '}
              {spread.intervalHoursLong === 1 ? 'hourly' : 'every 8h'}.
              Rate: <span className="tabular-nums">{fmtRate(spread.frLong, spread.intervalHoursLong)}</span>.
            </p>
            <p className="text-text-muted/60">
              The net yield ({fmtApy(spread.netApy30d)}) is annualized assuming current rates hold 30 days.
              Actual income is per-interval and differs as rates move.
            </p>
          </div>

          {/* Risks */}
          <SectionTitle title="Risks" />
          <div className="mb-6 space-y-2 font-mono text-[10px] text-text-muted leading-relaxed">
            {[
              {
                label: 'Funding flip',
                body: 'Rates can reverse between resets. If the short-side rate drops below the long-side rate, you pay net funding instead of collecting it.',
              },
              {
                label: leverage > 1 ? `Liquidation (${leverage}×)` : 'Liquidation',
                body: leverage > 1
                  ? `Both legs at ${leverage}× margin. Sharp mark-price moves can liquidate either leg before you can close. Maintain buffer margin.`
                  : 'At 1× liquidation risk from basis moves is low but not zero — extreme deviations can trigger margin calls on some exchanges.',
              },
              {
                label: 'Leg / execution risk',
                body: 'Opening or closing on two exchanges is not atomic. Price can move between fills, creating temporary directional exposure.',
              },
              {
                label: 'Basis drift',
                body: 'Mark and index price diverge temporarily (especially on DEX). A large basis move changes the effective funding rate.',
              },
              {
                label: 'Round-trip fees',
                body: `Total taker cost: ${spread.totalFeesPct.toFixed(3)}% of notional (open short ${shortTakerPct}% + open long ${longTakerPct}% + close short ${shortTakerPct}% + close long ${longTakerPct}%). Already subtracted from the net estimate. Recovered in ~${spread.breakevenDays}d at current spread.`,
              },
              {
                label: 'Exchange / counterparty',
                body: 'Insolvency, trading halts, or smart-contract bugs on either venue are non-zero risks.',
              },
              {
                label: 'Liquidity',
                body: spread.thinFlag
                  ? `THIN on at least one leg (capacity ≈ ${spread.capacityUsd != null ? '$' + (spread.capacityUsd / 1000).toFixed(0) + 'k' : 'unknown'}). Large orders will move the market against you.`
                  : `Est. deployable: ${spread.capacityUsd != null ? '$' + (spread.capacityUsd / 1000).toFixed(0) + 'k' : 'unknown'} (~1% of thinner leg's OI/vol). Slippage grows above this.`,
              },
            ].map(({ label, body }) => (
              <div key={label} className="flex items-start gap-3">
                <span className="text-warning/60 shrink-0 mt-px">▸</span>
                <span>
                  <span className="text-text-secondary font-medium">{label}: </span>
                  {body}
                </span>
              </div>
            ))}
          </div>

          {/* Alerts */}
          <SectionTitle title="Alerts — notification only, no orders placed" />

          {/* Status-change follow */}
          <div className="mb-3 px-4 py-3 bg-bg-panel border border-border">
            <p className="font-mono text-[10px] text-text-muted leading-relaxed mb-2">
              <span className="text-text-secondary">Status-change alert: </span>
              @Gaspola_bot sends one Telegram message when this opportunity&apos;s status changes
              (e.g. CAUTION → HARVEST or HARVEST → MARGINAL). Throttled to at most one per hour.
            </p>
            <a
              href={tgFollowHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block font-mono text-[10px] px-3 py-1.5 border border-accent/30 text-accent/70 hover:border-accent hover:text-accent transition-colors duration-100"
            >
              ✈ Follow {coin} on Telegram
            </a>
            <p className="font-mono text-[9px] text-text-muted/50 mt-1.5">
              Tapping opens Telegram and auto-sends <code>/start fund_{coin}</code> to the bot.
              Send <code>/list</code> to see active alerts · <code>/unfollow {coin}</code> · <code>/stop</code> for all.
            </p>
          </div>

          {/* Exit threshold alert */}
          <div className="mb-6 px-4 py-3 bg-bg-panel border border-border">
            <p className="font-mono text-[10px] text-text-muted leading-relaxed mb-1">
              <span className="text-text-secondary">Exit threshold alert: </span>
              sends one message when the gross spread drops below a level you set.
            </p>
            <p className="font-mono text-[9px] text-text-muted/60 mb-3 leading-relaxed">
              Default {marginalBoundary.toFixed(1)}%/yr = MARGINAL boundary (fees take {'>'} 10d to recover).
              Adjust to match your exit strategy. Alert resets if the spread recovers 10% above your threshold.
            </p>

            <div className="flex items-center gap-2 flex-wrap mb-3">
              <span className="font-mono text-[10px] text-text-muted">Alert me when gross spread drops below</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={effectiveThreshold}
                onChange={e => setAlertThreshold(Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-[4.5rem] px-1.5 py-0.5 font-mono text-[11px] bg-bg-panel border border-border text-text-primary focus:border-accent/50 focus:outline-none tabular-nums"
              />
              <span className="font-mono text-[10px] text-text-muted">%/yr gross spread</span>
            </div>

            <a
              href={tgAlertHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-[10px] px-3 py-1.5 border border-warning/30 text-warning/70 hover:border-warning hover:text-warning transition-colors duration-100"
            >
              ⚠ Set exit alert at {effectiveThreshold.toFixed(1)}%/yr in Telegram
            </a>

            <p className="font-mono text-[9px] text-text-muted/50 mt-2 leading-relaxed">
              Opens @Gaspola_bot. The bot stores your threshold per your Telegram chat ID and sends one alert
              when {coin} gross spread drops below {effectiveThreshold.toFixed(1)}%/yr.
              Message: &quot;{coin} spread at X%/yr — below your {effectiveThreshold.toFixed(1)}%/yr exit — consider closing both legs.&quot;
            </p>
            <p className="font-mono text-[9px] text-warning/60 mt-1 font-medium">
              This alert does not place, modify, or cancel any position on any exchange.
            </p>
          </div>

          {/* Disclaimer */}
          <div className="px-4 py-3 border border-border/30 bg-bg-elevated/10 font-mono text-[9px] text-text-muted/50 leading-relaxed">
            Educational only. Not financial advice. All numbers are derived from the current data snapshot and will change.
            Execution is entirely at your own risk — this page describes the mechanics of a funding rate arbitrage strategy, not a recommendation.
            Verify all figures on your exchange before committing capital.
          </div>
        </>
      )}
    </div>
  );
}
