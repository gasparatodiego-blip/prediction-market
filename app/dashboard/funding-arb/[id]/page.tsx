'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import PlatformLogo from '@/components/PlatformLogo';
import { Redacted, RedactedPanel } from '@/app/components/ui/Redacted';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FuturesCoin {
  markPrice?:             number | null;
  fundingRate:            number;
  fundingIntervalHours?:  number;
  nextFundingTime?:       number;
  openInterest?:          number | null;
  openInterestUsd?:       number | null;
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
  // null on free tier (server-side redaction) — see lib/paid-gating.ts.
  // netApy30d is a reliable single proxy for "is this row's derived-edge
  // data visible" — frShort/frLong/markPrice stay real for everyone.
  grossApy:           number | null;
  netApy30d:          number | null;
  totalFeesPct:       number | null;
  breakevenDays:      number | null;
  status:             'HARVEST' | 'CAUTION' | 'MARGINAL';
  liquidityTier:      string | null;
  capacityUsd:        number | null;
  thinFlag:           boolean;
  depthThin?:         boolean;
  depthNote?:         string | null;
  slipCurve:          SlipPoint[] | null;
  greenCapacityUsd:   number | null;
  slipCurveMaxFillable: number | null;
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
  if (s === 'HARVEST') return 'bg-mint-tint text-mint-deep border-mint-deep/25';
  if (s === 'CAUTION') return 'bg-gold/10 text-gold border-gold/25';
  return 'bg-coral-tint/50 text-coral-ink/70 border-coral-ink/25';
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StepLabel({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <span className="font-mono text-[9px] px-1.5 py-[2px] border border-line text-muted shrink-0 mt-0.5">
        {String(n).padStart(2, '0')}
      </span>
      <span className="font-body text-[11px] text-ink-2 font-medium">{text}</span>
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <h2 className="font-body text-[9px] uppercase tracking-widest text-muted mb-3 mt-6 border-b border-line/30 pb-1.5">
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

  const [data,       setData]       = useState<ApiResponse | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [capital,    setCapital]    = useState(1000);
  const [leverage,   setLeverage]   = useState<Leverage>(1);
  const [paybackDays, setPaybackDays] = useState(10);
  const [slipIdx,    setSlipIdx]    = useState(0);

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
  // grossApy/netApy30d/totalFeesPct/breakevenDays are redacted together as a
  // set for free tier — netApy30d is a reliable single proxy (see spread.netApy30d
  // comment above). The whole sizing calculator + execution guide gates on this,
  // same pattern as app/dashboard/prediction/[id]/page.tsx's isRedacted.
  const isRedacted = spread != null && spread.netApy30d == null;

  const shortMark = data?.futures?.[shortExchange]?.[coin]?.markPrice ?? null;
  const longMark  = data?.futures?.[longExchange]?.[coin]?.markPrice  ?? null;
  const markPrice = shortMark ?? longMark;

  // Sizing
  const notionalPerLeg = capital * leverage / 2;
  const qty            = markPrice != null && markPrice > 0
    ? notionalPerLeg / markPrice
    : null;

  // P&L estimates — all null when spread is absent OR redacted (never
  // computed off a null-coerced-to-0 field; see isRedacted above)
  const netYrUsd  = spread && spread.netApy30d   != null ? notionalPerLeg * spread.netApy30d / 100 : null;
  const dayUsd    = netYrUsd != null ? netYrUsd / 365 : null;
  const feesUsd   = spread && spread.totalFeesPct != null ? notionalPerLeg * spread.totalFeesPct / 100 : null;
  const net30dUsd = (netYrUsd != null && feesUsd != null && spread && spread.grossApy != null)
    ? notionalPerLeg * spread.grossApy / 100 * 30 / 365 - feesUsd
    : null;

  // Per-leg fee breakdown (taker) — only meaningful (and only rendered) when !isRedacted
  const shortTakerPct  = takerFeePct(shortExchange);
  const longTakerPct   = takerFeePct(longExchange);
  const shortMakerPct  = makerFeePct(shortExchange);
  const longMakerPct   = makerFeePct(longExchange);
  const makerTotalPct  = (shortMakerPct + longMakerPct) * 2;
  const makerSavingPct = spread && spread.totalFeesPct != null ? spread.totalFeesPct - makerTotalPct : 0;
  const makerSavingUsd = capital > 0 ? notionalPerLeg * makerSavingPct / 100 : 0;

  // Breakeven expressed in funding intervals
  const beShortIntervals = spread && spread.breakevenDays != null
    ? Math.ceil(spread.breakevenDays * 24 / spread.intervalHoursShort)
    : 0;
  const beLongIntervals  = spread && spread.breakevenDays != null
    ? Math.ceil(spread.breakevenDays * 24 / spread.intervalHoursLong)
    : 0;

  // MARGINAL boundary — gross spread below which fees take >paybackDays to recover
  // Formula: totalFeesPct × (365 / paybackDays) = the APY at which breakeven = paybackDays
  const marginalBoundary   = spread && spread.totalFeesPct != null ? +(spread.totalFeesPct * 365 / paybackDays).toFixed(1) : 5;
  const effectiveThreshold = marginalBoundary;

  const tgFollowHref = `https://t.me/Gaspola_bot?start=fund_${coin}`;
  const tgAlertHref  = `https://t.me/Gaspola_bot?start=fund_${coin}_exit_${Math.round(effectiveThreshold * 100)}`;

  // Slip-curve slider (detail page)
  const slipPts  = (spread?.slipCurve ?? []).filter(p => p.fillable);
  const slipPt   = slipPts[slipIdx] ?? null;
  const slipStateCls = (st: 'GREEN' | 'YELLOW' | 'RED') =>
    st === 'GREEN' ? 'text-mint-deep' : st === 'YELLOW' ? 'text-gold' : 'text-coral-ink/80';

  // Reset slider to greenCapacityUsd default when spread changes
  useEffect(() => {
    if (!spread?.slipCurve) { setSlipIdx(0); return; }
    const pts = spread.slipCurve.filter(p => p.fillable);
    const green = spread.greenCapacityUsd ?? 0;
    if (green > 0) {
      let last = 0;
      for (let i = 0; i < pts.length; i++) { if (pts[i].state === 'GREEN') last = i; }
      setSlipIdx(last);
    } else {
      setSlipIdx(0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spread?.coin, spread?.shortExchange, spread?.longExchange]);

  return (
    <div className="max-w-[860px] mx-auto px-4 py-6">

      {/* Back nav */}
      <div className="mb-5">
        <Link
          href="/dashboard/funding-arb"
          className="font-body text-[10px] text-muted hover:text-ink transition-colors duration-100"
        >
          ← Back to Funding Rate Monitor
        </Link>
      </div>

      {loading ? (
        <div className="py-20 text-center font-body text-[10px] uppercase tracking-widest text-muted animate-pulse">
          Loading…
        </div>
      ) : !data?.ok ? (
        <div className="py-20 text-center font-body text-[10px] text-coral-ink">
          Data unavailable — agent not running.
        </div>
      ) : !spread ? (
        <div className="py-20 text-center space-y-2">
          <div className="font-body text-[11px] text-muted">
            Opportunity not found: {coin} · {shortExchange} / {longExchange}
          </div>
          <div className="font-body text-[9px] text-muted/50">
            This pair may have dropped out of the current snapshot — check the main list.
          </div>
          <div className="mt-4">
            <Link href="/dashboard/funding-arb" className="font-body text-[10px] text-mint">
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
                <h1 className="font-display text-[22px] font-bold text-ink">{coin}</h1>
                <span className={`px-1.5 py-[2px] border text-[9px] font-body uppercase tracking-widest ${statusBadgeCls(spread.status)}`}>
                  {spread.status}
                </span>
                {spread.thinFlag && (
                  <span className="font-body text-[9px] text-gold">⚠ thin liquidity</span>
                )}
              </div>
              <p className="font-body text-[11px] text-muted inline-flex items-center flex-wrap">
                Short <PlatformLogo platform={shortExchange} size={12} className="mx-1" />{venueLabel(shortExchange)}{spread.shortIsDex ? ' (DEX)' : ''} ·{' '}
                Long <PlatformLogo platform={longExchange} size={12} className="mx-1" />{venueLabel(longExchange)}{spread.longIsDex ? ' (DEX)' : ''}
              </p>
              <p className="font-body text-[9px] text-muted/60 mt-1">
                Perp / Perp · both legs are perpetual futures · no spot leg
              </p>
            </div>
            <a
              href={tgFollowHref}
              target="_blank"
              rel="noopener noreferrer"
              className="font-body text-[10px] px-3 py-1.5 border border-mint/30 text-mint/70 hover:border-mint hover:text-mint transition-colors duration-100 rounded-button whitespace-nowrap"
            >
              ✈ Follow {coin} on Telegram
            </a>
          </div>

          {/* Current rates snapshot */}
          <div className="mb-5 px-4 py-3 bg-surface border border-line rounded-card font-body text-[11px]">
            <div className="text-[9px] uppercase tracking-widest text-muted mb-2">Live rates (current snapshot)</div>
            <div className="flex flex-wrap gap-x-8 gap-y-1.5">
              <span>
                <span className="text-muted inline-flex items-center">Short <PlatformLogo platform={shortExchange} size={11} className="mx-1" />{venueLabel(shortExchange)}: </span>
                <span className="text-mint-deep font-medium tabular-nums font-mono">collect {fmtRate(spread.frShort, spread.intervalHoursShort)}</span>
              </span>
              <span>
                <span className="text-muted inline-flex items-center">Long <PlatformLogo platform={longExchange} size={11} className="mx-1" />{venueLabel(longExchange)}: </span>
                <span className={`font-mono tabular-nums font-medium ${spread.frLong <= 0 ? 'text-mint-deep' : 'text-coral-ink/80'}`}>
                  {spread.frLong <= 0 ? 'collect' : 'pay'} {fmtRate(Math.abs(spread.frLong), spread.intervalHoursLong)}
                </span>
              </span>
              <span>
                <span className="text-muted">Gross spread: </span>
                <span className="text-ink tabular-nums font-mono">
                  <Redacted value={spread.grossApy}>{v => fmtApy(v)}</Redacted>
                </span>
              </span>
              <span>
                <span className="text-muted">Net (30d proj): </span>
                <span className={`tabular-nums font-mono font-medium ${(spread.netApy30d ?? 0) > 0 ? 'text-mint-deep' : 'text-coral-ink'}`}>
                  <Redacted value={spread.netApy30d}>{v => fmtApy(v)}</Redacted>
                </span>
              </span>
            </div>
            {data.staleMinutes != null && data.staleMinutes > 5 && (
              <div className="mt-2 text-[9px] text-gold">Data is {data.staleMinutes}m old — rates may have shifted.</div>
            )}
          </div>

          {/* Everything below (sizing calculator, slip slider, execution guide,
              exit triggers, settlement detail, risks, alert thresholds) derives
              from the same redacted-together field set — one gate, matching
              prediction/[id]/page.tsx's isRedacted pattern, rather than ~30
              individually-blurred numbers across a dense multi-section guide. */}
          {isRedacted ? (
            <RedactedPanel
              label="The full position-sizing calculator, execution guide, breakeven math and exit-alert thresholds are available on Pro"
              className="mt-4 mb-6"
            />
          ) : (
          <>

          {/* Capital & leverage input */}
          <div className="mb-5 px-4 py-3 bg-surface border border-line rounded-card">
            <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-2">Your capital</div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-1">
                <span className="font-body text-[10px] text-muted">$</span>
                <input
                  type="number" min={0} step={100} value={capital}
                  onChange={e => setCapital(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="w-[5rem] px-1.5 py-0.5 font-mono text-[11px] bg-surface border border-line text-ink focus:border-mint/50 focus:outline-none tabular-nums rounded-sm"
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
                    className={`px-1.5 py-0.5 font-body text-[10px] border transition-colors duration-100 cursor-help rounded-sm ${
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
                <span className="font-body text-[9px] text-gold/70">
                  {leverage}× applied to both perp legs — liquidation risk if basis widens
                </span>
              )}
            </div>
          </div>

          {/* Slip-aware capacity slider */}
          {slipPts.length > 0 && (
            <div className="mb-5 px-4 py-4 border border-line rounded-card">
              <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-3">
                Liquidity-aware sizing · incl. modeled entry/exit slippage (14d amortized)
              </div>
              <p className="font-body text-[9px] text-muted/55 mb-3 leading-relaxed">
                Capacity = size you can enter before slippage eats &gt;30% of gross yield.
                {(spread.greenCapacityUsd ?? 0) === 0
                  ? ' Honest capacity is $0 here — books are thin at all tested sizes. Drag to see the cost at each level.'
                  : ` Green cap: ${spread.greenCapacityUsd != null
                      ? (spread.greenCapacityUsd >= 1_000_000 ? `~$${(spread.greenCapacityUsd/1_000_000).toFixed(1)}M` : spread.greenCapacityUsd >= 1_000 ? `~$${Math.round(spread.greenCapacityUsd/1_000)}k` : `~$${spread.greenCapacityUsd}`)
                      : '—'}.`
                }
              </p>

              {/* Slider */}
              <div className="flex items-center gap-2 mb-3">
                <span className="font-body text-[9px] text-muted shrink-0">Position</span>
                <input
                  type="range"
                  min={0}
                  max={slipPts.length - 1}
                  value={slipIdx}
                  step={1}
                  onChange={e => setSlipIdx(parseInt(e.target.value))}
                  className="flex-1 h-[3px] accent-mint cursor-pointer"
                />
                {slipPt && (
                  <span className="font-mono text-[10px] tabular-nums text-ink-2 shrink-0 w-16 text-right">
                    {slipPt.size >= 1_000_000 ? `$${(slipPt.size/1_000_000).toFixed(1)}M` : slipPt.size >= 1_000 ? `$${Math.round(slipPt.size/1_000)}k` : `$${slipPt.size}`}
                  </span>
                )}
                {slipPt && (
                  <span className={`font-mono text-[10px] font-semibold shrink-0 w-14 text-right ${slipStateCls(slipPt.state)}`}>
                    {slipPt.state}
                  </span>
                )}
              </div>

              {/* Numbers at slider position */}
              {slipPt && (
                <div className="flex flex-wrap gap-x-6 gap-y-1.5 font-mono text-[11px]">
                  <span>
                    <span className={`text-[18px] font-bold tabular-nums ${slipStateCls(slipPt.state)}`}>
                      {slipPt.netDayUsd != null
                        ? `${slipPt.netDayUsd >= 0 ? '≈ $' : '-$'}${Math.abs(slipPt.netDayUsd).toFixed(2)}/day`
                        : '—'}
                    </span>
                  </span>
                  <span>
                    <span className="text-muted">ROC: </span>
                    <span className={`tabular-nums font-medium ${slipStateCls(slipPt.state)}`}>
                      {slipPt.netDayUsd != null && slipPt.size > 0
                        ? `${(slipPt.netDayUsd * 365 / slipPt.size * 100) >= 0 ? '+' : ''}${(slipPt.netDayUsd * 365 / slipPt.size * 100).toFixed(1)}%/yr`
                        : '—'
                      }
                    </span>
                    <span className="text-muted/50 text-[9px] ml-1">run-rate · not guaranteed</span>
                  </span>
                  {slipPt.slipBps != null && (
                    <span>
                      <span className="text-muted">Slip: </span>
                      <span className="tabular-nums text-ink-2">{slipPt.slipBps}bps</span>
                      <span className="text-muted/50 text-[9px] ml-1">round-trip</span>
                    </span>
                  )}
                  {slipPt.slipOverGross != null && (
                    <span>
                      <span className="text-muted">Slip/yield: </span>
                      <span className={`tabular-nums ${slipStateCls(slipPt.state)}`}>{slipPt.slipOverGross}%</span>
                      <span className="text-muted/50 text-[9px] ml-1">of 14d gross</span>
                    </span>
                  )}
                </div>
              )}

              {/* Curve summary — all points */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {slipPts.map((pt, i) => (
                  <button
                    key={pt.size}
                    onClick={() => setSlipIdx(i)}
                    className={`font-mono text-[8px] px-1.5 py-0.5 border transition-colors duration-100 rounded-sm ${
                      i === slipIdx
                        ? pt.state === 'GREEN'  ? 'bg-mint-tint border-mint-deep/50 text-mint-deep'
                        : pt.state === 'YELLOW' ? 'bg-gold/20 border-gold/50 text-gold'
                        :                         'bg-coral-tint/50 border-coral-ink/30 text-coral-ink/80'
                        : 'border-line text-muted/50 hover:border-muted'
                    }`}
                  >
                    {pt.size >= 1_000 ? `$${Math.round(pt.size/1_000)}k` : `$${pt.size}`}
                    <span className="ml-0.5 opacity-60">{pt.state[0]}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Sizing + fee breakdown */}
          {capital > 0 && (
            <div className="mb-6 px-4 py-4 border border-mint-deep/25 bg-mint-tint/30 rounded-card">

              <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-2">
                Estimated outcome at ${capital.toLocaleString()}{leverage > 1 ? ` · ${leverage}×` : ''}
              </div>

              {/* Key metrics row */}
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 font-mono text-[11px] mb-4">
                <span>
                  <span className="text-muted">Notional/leg: </span>
                  <span className="text-ink tabular-nums font-medium">{fmtUsd(notionalPerLeg)}</span>
                </span>
                {qty != null && markPrice != null && (
                  <span>
                    <span className="text-muted">Qty: </span>
                    <span className="text-ink tabular-nums font-medium">{fmtQty(qty)} {coin}</span>
                    <span className="text-muted/50 text-[9px] ml-1">@ ${markPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  </span>
                )}
                {dayUsd != null && (
                  <span>
                    <span className="text-mint-deep font-bold text-[14px] tabular-nums">{fmtUsd(dayUsd)}/day</span>
                    <span className="text-muted/50 text-[9px] ml-1">(net, annualized at current rate)</span>
                  </span>
                )}
                {net30dUsd != null && (
                  <span>
                    <span className="text-muted">Net 30d: </span>
                    <span className={`tabular-nums font-medium ${net30dUsd >= 0 ? 'text-mint-deep' : 'text-coral-ink'}`}>
                      {fmtUsd(net30dUsd)}
                    </span>
                    <span className="text-muted/50 text-[9px] ml-1">(if rate holds 30d)</span>
                  </span>
                )}
              </div>

              {/* Fee breakdown */}
              <div className="border-t border-line/30 pt-3">
                <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-2">
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
                      <span className="text-muted w-[70px] shrink-0">{action}</span>
                      <span className="text-ink-2 w-[90px] shrink-0 inline-flex items-center gap-1"><PlatformLogo platform={ex} size={10} />{venueLabel(ex)}</span>
                      <span className="text-muted/60 tabular-nums w-[55px] shrink-0 text-[9px]">{pct}%/leg</span>
                      <span className="text-muted/50 text-[9px] shrink-0">×</span>
                      <span className="text-muted/60 tabular-nums text-[9px] shrink-0">{fmtUsd(notionalPerLeg)}</span>
                      <span className="text-muted/50 text-[9px] shrink-0">=</span>
                      <span className="tabular-nums text-coral-ink/70 ml-auto">{fmtUsd(-(notionalPerLeg * pct / 100))}</span>
                    </div>
                  ))}
                  <div className="flex items-baseline gap-2 border-t border-line/30 pt-1.5 mt-1">
                    <span className="text-ink-2 font-medium">Total</span>
                    <span className="text-muted/50 text-[9px] ml-1">({spread.totalFeesPct!.toFixed(3)}% of notional/leg)</span>
                    <span className="tabular-nums text-coral-ink font-medium ml-auto">
                      {feesUsd != null ? fmtUsd(-feesUsd) : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between text-[9px] text-muted/60">
                    <span>Recovered in ≈{spread.breakevenDays}d at current rate</span>
                    <span>Already subtracted from net estimate above</span>
                  </div>
                </div>

                {/* Maker alternative */}
                <div className="mt-3 pt-2.5 border-t border-line/15 font-body text-[9px] text-muted/70 leading-relaxed">
                  <span className="text-muted">Estimated maker fees (if using limit orders): </span>
                  <PlatformLogo platform={shortExchange} size={10} className="mr-1" />
                  {shortExchange === 'hyperliquid'
                    ? `${venueLabel(shortExchange)} maker = 0% (confirmed)`
                    : `${venueLabel(shortExchange)} est. maker ≈ ${shortMakerPct}%/leg`
                  }
                  {' / '}
                  <PlatformLogo platform={longExchange} size={10} className="mr-1" />
                  {longExchange === 'hyperliquid'
                    ? `${venueLabel(longExchange)} maker = 0% (confirmed)`
                    : `${venueLabel(longExchange)} est. maker ≈ ${longMakerPct}%/leg`
                  }
                  {makerSavingPct > 0.001 && (
                    <> — est. saving ≈{fmtUsd(makerSavingUsd)} vs taker on this capital.</>
                  )}
                  <span className="text-gold/70">
                    {' '}Risk: limit orders on two venues cannot be guaranteed to fill simultaneously.
                    A partial fill on one leg creates a one-sided directional position.
                    Use taker (market/IOC) to guarantee both fills close together.
                  </span>
                </div>
              </div>

              <p className="font-body text-[9px] text-muted/50 mt-3 leading-relaxed">
                Estimates assume the current snapshot rate holds. Rate resets{' '}
                {intervalLabel(Math.min(spread.intervalHoursShort, spread.intervalHoursLong))} and can move in either direction.
                Treat all figures as an upper bound, not a guarantee.
              </p>
            </div>
          )}

          {/* Execution guide */}
          <SectionTitle title="Step-by-step execution guide" />
          <div className="space-y-0 mb-6">

            <div className="border-b border-line/20 pb-4 mb-4">
              <StepLabel n={1} text="Fund both exchange accounts" />
              <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1">
                <p>
                  Transfer {settlementCurrency(shortExchange)} to{' '}
                  <span className="text-ink-2 inline-flex items-center gap-1"><PlatformLogo platform={shortExchange} size={11} />{venueLabel(shortExchange)}</span>
                  {spread.shortIsDex ? ' (bridge from mainnet via USDC — allow ~10 min + gas)' : ''}.
                </p>
                <p>
                  Transfer {settlementCurrency(longExchange)} to{' '}
                  <span className="text-ink-2 inline-flex items-center gap-1"><PlatformLogo platform={longExchange} size={11} />{venueLabel(longExchange)}</span>
                  {spread.longIsDex ? ' (bridge from mainnet via USDC — allow ~10 min + gas)' : ''}.
                </p>
                {capital > 0 && (
                  <p className="text-muted/70 mt-1">
                    Target: ≈<span className="font-mono">{fmtUsd(notionalPerLeg)}</span> margin on each side
                    {leverage > 1 ? ` (${leverage}× leverage — adjust margin to exchange minimum)` : ''}.
                  </p>
                )}
              </div>
            </div>

            <div className="border-b border-line/20 pb-4 mb-4">
              <StepLabel n={2} text={`Open SHORT on ${venueLabel(shortExchange)}`} />
              <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1">
                <p>
                  Instrument: <span className="text-ink-2">{coin}-PERP</span> (USDT-margined perpetual)
                </p>
                <p>
                  Direction: <span className="text-coral-ink/80 font-medium">SHORT</span>
                  {qty != null && (
                    <span> · <span className="font-mono tabular-nums">{fmtQty(qty)} {coin}</span></span>
                  )}
                  {capital > 0 && (
                    <span> · Notional: <span className="text-ink font-mono tabular-nums">{fmtUsd(notionalPerLeg)}</span></span>
                  )}
                </p>
                <p>
                  You will <span className="text-mint-deep">collect</span> funding of{' '}
                  <span className="text-mint-deep font-mono tabular-nums">{fmtRate(spread.frShort, spread.intervalHoursShort)}</span>{' '}
                  {intervalLabel(spread.intervalHoursShort)} in {settlementCurrency(shortExchange)}.
                </p>
                <p className="text-[9px] text-muted/60 border-l border-line/30 pl-2 mt-1">
                  <span className="text-muted">Fee assumption: </span>
                  taker {shortTakerPct}%/leg (real published rate — used in net estimate above).
                  {shortExchange === 'hyperliquid'
                    ? ' Est. maker = 0% on HL — free if filled, but no fill guarantee.'
                    : ` Est. maker ≈${shortMakerPct}%/leg if filled — cheaper, but no simultaneous-fill guarantee with the other leg. Verify on exchange.`
                  }
                </p>
              </div>
            </div>

            <div className="border-b border-line/20 pb-4 mb-4">
              <StepLabel n={3} text={`Open LONG on ${venueLabel(longExchange)}`} />
              <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1">
                <p>
                  Instrument: <span className="text-ink-2">{coin}-PERP</span> (USDT-margined perpetual)
                </p>
                <p>
                  Direction: <span className="text-mint-deep/80 font-medium">LONG</span>
                  {qty != null && (
                    <span> · <span className="font-mono tabular-nums">{fmtQty(qty)} {coin}</span></span>
                  )}
                  {capital > 0 && (
                    <span> · Notional: <span className="text-ink font-mono tabular-nums">{fmtUsd(notionalPerLeg)}</span></span>
                  )}
                </p>
                <p>
                  {spread.frLong <= 0
                    ? <>Also <span className="text-mint-deep">collect</span> funding of{' '}
                        <span className="text-mint-deep font-mono tabular-nums">{fmtRate(Math.abs(spread.frLong), spread.intervalHoursLong)}</span> on this leg.</>
                    : <><span className="text-coral-ink/80">Pay</span> funding of{' '}
                        <span className="text-coral-ink/80 font-mono tabular-nums">{fmtRate(spread.frLong, spread.intervalHoursLong)}</span>{' '}
                        {intervalLabel(spread.intervalHoursLong)} in {settlementCurrency(longExchange)}.</>
                  }
                </p>
                <p className="text-[9px] text-muted/60 border-l border-line/30 pl-2 mt-1">
                  <span className="text-muted">Fee assumption: </span>
                  taker {longTakerPct}%/leg (real published rate — used in net estimate above).
                  {longExchange === 'hyperliquid'
                    ? ' Est. maker = 0% on HL — free if filled, but no fill guarantee.'
                    : ` Est. maker ≈${longMakerPct}%/leg if filled — cheaper, but no simultaneous-fill guarantee. Verify on exchange.`
                  }
                </p>
              </div>
            </div>

            <div className="border-b border-line/20 pb-4 mb-4">
              <StepLabel n={4} text="Open both legs as simultaneously as possible" />
              <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed">
                <p>
                  Between opening the first and second leg, {coin} price can move.
                  An unhedged leg is a directional bet.
                  At 1× the risk equals one tick × qty; at higher leverage the open notional is larger.
                  Minimize the time between fills — use two browser tabs or an automation if available.
                </p>
              </div>
            </div>

            <div className="border-b border-line/20 pb-4 mb-4">
              <StepLabel n={5} text="Monitor funding resets" />
              <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1.5">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  <span>
                    <span className="text-ink-2 inline-flex items-center gap-1"><PlatformLogo platform={shortExchange} size={11} />{venueLabel(shortExchange)}: </span>
                    {spread.intervalHoursShort === 1
                      ? `resets every hour — 24 payments/day in ${settlementCurrency(shortExchange)}`
                      : `resets 00:00 / 08:00 / 16:00 UTC — 3 payments/day in ${settlementCurrency(shortExchange)}`
                    }
                  </span>
                  <span>
                    <span className="text-ink-2 inline-flex items-center gap-1"><PlatformLogo platform={longExchange} size={11} />{venueLabel(longExchange)}: </span>
                    {spread.intervalHoursLong === 1
                      ? `resets every hour — 24 payments/day in ${settlementCurrency(longExchange)}`
                      : `resets 00:00 / 08:00 / 16:00 UTC — 3 payments/day in ${settlementCurrency(longExchange)}`
                    }
                  </span>
                </div>
                <p className="text-muted/60">
                  Funding accrues directly to your margin balance — no action needed between resets.
                </p>
              </div>
            </div>

            <div className="border-b border-line/20 pb-4 mb-4">
              <StepLabel n={6} text="Exit: close both legs simultaneously" />
              <div className="ml-[42px] font-body text-[10px] text-muted leading-relaxed space-y-1.5">

                {/* Breakeven box */}
                <div className="px-3 py-2 border border-gold/20 bg-gold/5 rounded-card mb-2">
                  <p className="text-ink-2 font-medium text-[10px]">
                    Breakeven: hold for at least {spread.breakevenDays}d to recover round-trip fees
                  </p>
                  <p className="text-[9px] text-muted/80 mt-0.5">
                    = {beShortIntervals} {spread.intervalHoursShort === 1 ? 'hourly' : '8h'} intervals on {venueLabel(shortExchange)}
                    {beLongIntervals !== beShortIntervals && (
                      <> / {beLongIntervals} {spread.intervalHoursLong === 1 ? 'hourly' : '8h'} intervals on {venueLabel(longExchange)}</>
                    )}
                  </p>
                  <p className="text-[9px] text-gold/80 mt-1">
                    Exiting before {spread.breakevenDays}d means fees exceed what you&apos;ve earned — you lose money
                    even if every funding payment was positive.
                  </p>
                </div>

                <p className="text-muted">Close both legs when any trigger occurs:</p>
                <ul className="list-none space-y-0.5 ml-3 text-[9px]">
                  <li>· Gross spread drops below ≈{marginalBoundary.toFixed(1)}%/yr (fees take {'>'}{paybackDays}d to recover — your minimum).</li>
                  <li>· Short-side rate flips negative — you begin paying instead of collecting.</li>
                  <li>· Net funding income on either interval is negative.</li>
                  <li>· Margin on either leg drops below your risk threshold.</li>
                </ul>
                <p className="text-[9px] text-muted/60 mt-1">
                  Use taker (market/IOC) on exit to guarantee fill — leg risk on close is identical to leg risk on open.
                  Close both legs within the same minute where possible.
                </p>
              </div>
            </div>

          </div>

          {/* When to exit — computed */}
          <SectionTitle title="Exit triggers — computed from current data" />
          <div className="mb-6 px-4 py-4 bg-surface border border-line rounded-card">

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-4 mb-4">
              <div>
                <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-1">Breakeven hold time</div>
                <div className="font-mono text-[18px] font-bold text-ink tabular-nums">{spread.breakevenDays}d</div>
                <div className="font-body text-[9px] text-muted/70 mt-0.5 leading-relaxed">
                  {beShortIntervals} intervals ({spread.intervalHoursShort}h) on {venueLabel(shortExchange)}
                  {beLongIntervals !== beShortIntervals && (
                    <><br />{beLongIntervals} intervals ({spread.intervalHoursLong}h) on {venueLabel(longExchange)}</>
                  )}
                </div>
              </div>
              <div>
                <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-1">Exit at gross spread ≤</div>
                <div className="font-mono text-[18px] font-bold text-gold tabular-nums">{marginalBoundary.toFixed(1)}%/yr</div>
                <div className="font-body text-[9px] text-muted/70 mt-0.5">
                  fees take {'>'}{paybackDays}d to recover at this spread
                </div>
              </div>
              <div>
                <div className="font-body text-[9px] uppercase tracking-widest text-muted mb-1">Current gross spread</div>
                <div className={`font-mono text-[18px] font-bold tabular-nums ${spread.grossApy! > marginalBoundary ? 'text-mint-deep' : 'text-coral-ink'}`}>
                  {fmtApy(spread.grossApy!)}
                </div>
                <div className="font-body text-[9px] text-muted/70 mt-0.5">
                  {spread.grossApy! > marginalBoundary
                    ? `+${(spread.grossApy! - marginalBoundary).toFixed(1)}%/yr above exit trigger`
                    : 'below exit trigger — consider closing'
                  }
                </div>
              </div>
            </div>

            <div className="border-t border-line/20 pt-3 font-body text-[9px] text-muted leading-relaxed space-y-1.5">
              <p>
                <span className="text-ink-2">Breakeven formula: </span>
                round-trip fees ({spread.totalFeesPct!.toFixed(3)}%) ÷ gross spread ({spread.grossApy!.toFixed(2)}%/yr) × 365 = {spread.breakevenDays}d
              </p>
              <p>
                <span className="text-ink-2">Exit threshold: </span>
                {spread.totalFeesPct!.toFixed(3)}% × (365 ÷ {paybackDays}d) = {marginalBoundary.toFixed(1)}%/yr — the gross spread at which breakeven extends past {paybackDays} days. Adjust the payback period in the alert section below.
              </p>
              <p>
                <span className="text-ink-2">Recommended exit when: </span>
                gross spread falls below {marginalBoundary.toFixed(1)}%/yr
                OR the short-leg rate flips sign
                OR basis risk / margin buffer is consumed.
              </p>
              <p className="text-muted/50 mt-1">
                Computed from current snapshot. Rate resets {intervalLabel(spread.intervalHoursShort === 1 ? 1 : 8)} — verify manually at each reset.
                These are mechanical triggers, not financial advice.
              </p>
            </div>
          </div>

          {/* Funding settlement detail */}
          <SectionTitle title="Funding settlement detail" />
          <div className="mb-6 px-4 py-3 bg-surface border border-line rounded-card font-body text-[10px] text-muted leading-relaxed space-y-2">
            <p>
              All contracts are <span className="text-ink-2">linear (USDT/USDC-margined) perpetuals</span>.
              No inverse (coin-margined) legs.
            </p>
            <p>
              <span className="text-ink-2 inline-flex items-center gap-1"><PlatformLogo platform={shortExchange} size={11} />{venueLabel(shortExchange)} short leg: </span>
              funding credited to you in <span className="text-ink">{settlementCurrency(shortExchange)}</span>,{' '}
              {spread.intervalHoursShort === 1 ? 'hourly' : 'every 8h'}.
              Rate: <span className="text-mint-deep font-mono tabular-nums">{fmtRate(spread.frShort, spread.intervalHoursShort)}</span>.
            </p>
            <p>
              <span className="text-ink-2 inline-flex items-center gap-1"><PlatformLogo platform={longExchange} size={11} />{venueLabel(longExchange)} long leg: </span>
              {spread.frLong >= 0
                ? <>funding <span className="text-coral-ink/80">debited from you</span> in{' '}</>
                : <>funding <span className="text-mint-deep">credited to you</span> in{' '}</>
              }
              <span className="text-ink">{settlementCurrency(longExchange)}</span>,{' '}
              {spread.intervalHoursLong === 1 ? 'hourly' : 'every 8h'}.
              Rate: <span className="font-mono tabular-nums">{fmtRate(spread.frLong, spread.intervalHoursLong)}</span>.
            </p>
            <p className="text-muted/60">
              The net yield ({fmtApy(spread.netApy30d!)}) is annualized assuming current rates hold 30 days.
              Actual income is per-interval and differs as rates move.
            </p>
          </div>

          {/* Risks */}
          <SectionTitle title="Risks" />
          <div className="mb-6 space-y-2 font-body text-[10px] text-muted leading-relaxed">
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
                body: `Total taker cost: ${spread.totalFeesPct!.toFixed(3)}% of notional (open short ${shortTakerPct}% + open long ${longTakerPct}% + close short ${shortTakerPct}% + close long ${longTakerPct}%). Already subtracted from the net estimate. Recovered in ~${spread.breakevenDays}d at current spread.`,
              },
              {
                label: 'Exchange / counterparty',
                body: 'Insolvency, trading halts, or smart-contract bugs on either venue are non-zero risks.',
              },
              {
                label: 'Liquidity',
                body: (spread.depthThin ?? spread.thinFlag)
                  ? `${spread.depthNote ?? 'THIN — book depth limited'}. Large orders will move the market against you.`
                  : `Est. deployable: ${spread.capacityUsd != null ? '$' + (spread.capacityUsd / 1000).toFixed(0) + 'k' : 'unknown'} (fillable within 20bps of mid). Slippage grows above this.`,
              },
            ].map(({ label, body }) => (
              <div key={label} className="flex items-start gap-3">
                <span className="text-gold/60 shrink-0 mt-px">▸</span>
                <span>
                  <span className="text-ink-2 font-medium">{label}: </span>
                  {body}
                </span>
              </div>
            ))}
          </div>

          {/* Alerts */}
          <SectionTitle title="Alerts — notification only, no orders placed" />

          {/* Status-change follow */}
          <div className="mb-3 px-4 py-3 bg-surface border border-line rounded-card">
            <p className="font-body text-[10px] text-muted leading-relaxed mb-2">
              <span className="text-ink-2">Status-change alert: </span>
              @Gaspola_bot sends one Telegram message when this opportunity&apos;s status changes
              (e.g. CAUTION → HARVEST or HARVEST → MARGINAL). Throttled to at most one per hour.
            </p>
            <a
              href={tgFollowHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block font-body text-[10px] px-3 py-1.5 border border-mint/30 text-mint/70 hover:border-mint hover:text-mint transition-colors duration-100 rounded-button"
            >
              ✈ Follow {coin} on Telegram
            </a>
            <p className="font-body text-[9px] text-muted/50 mt-1.5">
              Tapping opens Telegram and auto-sends <code>/start fund_{coin}</code> to the bot.
              Send <code>/list</code> to see active alerts · <code>/unfollow {coin}</code> · <code>/stop</code> for all.
            </p>
          </div>

          {/* Exit threshold alert */}
          <div className="mb-6 px-4 py-3 bg-surface border border-line rounded-card">
            <p className="font-body text-[10px] text-muted leading-relaxed mb-1">
              <span className="text-ink-2">Exit threshold alert: </span>
              sends one message when the gross spread drops below a level you set.
            </p>
            <p className="font-body text-[9px] text-muted/60 mb-2 leading-relaxed">
              Alert fires when gross spread falls below the fee-payback threshold you set.
              Alert resets if the spread recovers 10% above the threshold.
            </p>

            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="font-body text-[10px] text-muted">Minimum fee-payback period</span>
              <input
                type="number"
                min={1}
                step={1}
                value={paybackDays}
                onChange={e => setPaybackDays(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-[3.5rem] px-1.5 py-0.5 font-mono text-[11px] bg-surface border border-line text-ink focus:border-mint/50 focus:outline-none tabular-nums rounded-sm"
              />
              <span className="font-body text-[10px] text-muted">days</span>
            </div>
            {spread && (
              <p className="font-body text-[9px] text-muted/50 mb-3 leading-relaxed">
                {spread.totalFeesPct!.toFixed(3)}% fees × (365 ÷ {paybackDays}d) ={' '}
                <span className="text-gold font-mono">{effectiveThreshold.toFixed(1)}%/yr</span>
                {' '}— alert triggers when gross spread drops below this.
              </p>
            )}

            <a
              href={tgAlertHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-body text-[10px] px-3 py-1.5 border border-gold/30 text-gold/70 hover:border-gold hover:text-gold transition-colors duration-100 rounded-button"
            >
              ⚠ Set exit alert at {effectiveThreshold.toFixed(1)}%/yr ({paybackDays}d payback) in Telegram
            </a>

            <p className="font-body text-[9px] text-muted/50 mt-2 leading-relaxed">
              Opens @Gaspola_bot. The bot stores your threshold per your Telegram chat ID and sends one alert
              when {coin} gross spread drops below {effectiveThreshold.toFixed(1)}%/yr ({paybackDays}d fee-payback threshold).
              Message: &quot;{coin} spread at X%/yr — below your {effectiveThreshold.toFixed(1)}%/yr exit — consider closing both legs.&quot;
            </p>
            <p className="font-body text-[9px] text-gold/60 mt-1 font-medium">
              This alert does not place, modify, or cancel any position on any exchange.
            </p>
          </div>

          </>
          )}

          {/* Disclaimer */}
          <div className="px-4 py-3 border border-line/30 bg-bg-soft/10 rounded-card font-body text-[9px] text-muted/50 leading-relaxed">
            Educational only. Not financial advice. All numbers are derived from the current data snapshot and will change.
            Execution is entirely at your own risk — this page describes the mechanics of a funding rate arbitrage strategy, not a recommendation.
            Verify all figures on your exchange before committing capital.
          </div>
        </>
      )}
    </div>
  );
}
