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
  greenCapacityUsd:   number | null;
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

// Fixed fee-payback horizon used to derive the exit threshold shown on the
// Telegram alert row. (The old page let the user tune this; the concise
// redesign fixes it at 10d — the same default the list surfaces.)
const PAYBACK_DAYS = 10;

// ── Display helpers ───────────────────────────────────────────────────────────

function venueLabel(e: string): string {
  if (e === 'dydx')        return 'dYdX';
  if (e === 'hyperliquid') return 'Hyperliquid';
  if (e === 'gateio')      return 'Gate.io';
  if (e === 'bitget')      return 'Bitget';
  return e.charAt(0).toUpperCase() + e.slice(1).toLowerCase();
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

// Payback formatter — mirror of the list page's single copy. Under 24h → "12h";
// ≥24h → "2d 10h" (drops hours when exact → "3d"); missing/null → "—".
function formatPayback(days: number | null | undefined): string {
  if (days == null || !isFinite(days)) return '—';
  const h = Math.round(days * 24);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24), r = h % 24;
  return r === 0 ? `${d}d` : `${d}d ${r}h`;
}

// Normalize any leg's native funding rate onto a common %/8h basis (CEX 8h vs
// DEX 1h). DISPLAY ONLY — never feeds math. Mirror of the list page's fmtRate8h.
function fmtRate8h(rateNative: number, intervalHours: number | undefined): string {
  const iv = intervalHours && intervalHours > 0 ? intervalHours : 8;
  const v  = rateNative * (8 / iv);
  return `${v >= 0 ? '+' : ''}${v.toFixed(4)}%`;
}

// Honest capacity display — mirror of the list page. Below the $500k ladder top
// the value is a real order-book estimate → "~$N". At/above the top rung the
// book is deeper than we measure → a truthful floor "$500k+".
const SIZE_LADDER_TOP_RUNG = 500_000;
function fmtCapDisplay(n: number): string {
  if (n >= SIZE_LADDER_TOP_RUNG) return `$${Math.round(SIZE_LADDER_TOP_RUNG / 1_000)}k+`;
  return `~$${Math.round(n).toLocaleString('en-US')}`;
}

// Cash-flow direction of one leg from the funding-rate SIGN (not the trade side).
// SHORT leg: rate > 0 → collect; LONG leg: rate < 0 → collect. Mirror of the
// list page's legCashflow — display only.
type LegFlow = 'collect' | 'pay' | 'flat';
function legCashflow(side: 'short' | 'long', signedRate: number): LegFlow {
  if (signedRate === 0) return 'flat';
  const collects = side === 'short' ? signedRate > 0 : signedRate < 0;
  return collects ? 'collect' : 'pay';
}
const FLOW_COLOR: Record<LegFlow, string> = { collect: '#0f766e', pay: '#e11d48', flat: '#9aa5b3' };

const STATUS_STYLE: Record<SpreadItem['status'], { color: string; bg: string; border: string }> = {
  HARVEST:  { color: '#0f766e', bg: '#e6f4f1', border: 'rgba(15,118,110,0.25)' },
  CAUTION:  { color: '#b45309', bg: '#fdf6ec', border: 'rgba(180,83,9,0.25)' },
  MARGINAL: { color: '#6b7787', bg: '#f1f4f7', border: '#cbd3dc' },
};

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FundingArbDetailPage({ params }: { params: { id: string } }) {
  const parts         = params.id.split('-');
  const coin          = parts[0]?.toUpperCase() ?? '';
  const shortExchange = parts[1] ?? '';
  const longExchange  = parts[2] ?? '';

  const [data,     setData]     = useState<ApiResponse | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [capital,  setCapital]  = useState(1000);
  const [leverage, setLeverage] = useState<Leverage>(1);

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
  // grossApy/netApy30d/totalFeesPct/breakevenDays/greenCapacityUsd are redacted
  // together as a set for free tier — netApy30d is a reliable single proxy. The
  // sizing control + how-to-execute steps gate on this; the summary rates and the
  // Telegram/auto-execute card stay public (rates are real for everyone).
  const isRedacted = spread != null && spread.netApy30d == null;

  const shortMark = data?.futures?.[shortExchange]?.[coin]?.markPrice ?? null;
  const longMark  = data?.futures?.[longExchange]?.[coin]?.markPrice  ?? null;
  const markPrice = shortMark ?? longMark;

  // Sizing — notional split equally per leg (market-neutral).
  const notionalPerLeg = capital * leverage / 2;
  const qty            = markPrice != null && markPrice > 0 ? notionalPerLeg / markPrice : null;

  // P&L estimates — null when spread absent OR redacted (never off a null-coerced field).
  const netYrUsd = spread && spread.netApy30d   != null ? notionalPerLeg * spread.netApy30d / 100 : null;
  const dayUsd   = netYrUsd != null ? netYrUsd / 365 : null;
  const feesUsd  = spread && spread.totalFeesPct != null ? notionalPerLeg * spread.totalFeesPct / 100 : null;

  // Exit threshold: fees × (365 / paybackDays) = APY at which breakeven = paybackDays.
  const effectiveThreshold = spread && spread.totalFeesPct != null
    ? +(spread.totalFeesPct * 365 / PAYBACK_DAYS).toFixed(1)
    : 0;

  const tgFollowHref = `https://t.me/Gaspola_bot?start=fund_${coin}`;

  // Leg cash-flow direction (from rate sign) drives chip colour + summary caption.
  const shortFlow  = spread ? legCashflow('short', spread.frShort) : 'flat';
  const longFlow   = spread ? legCashflow('long',  spread.frLong)  : 'flat';
  const bothCollect = shortFlow === 'collect' && longFlow === 'collect';
  const caption     = bothCollect ? 'market-neutral · both collect' : 'market-neutral · net spread';

  const settleNote = spread && (spread.intervalHoursShort === 1 || spread.intervalHoursLong === 1)
    ? 'every 8h (hourly on the DEX leg)'
    : 'every 8h';

  const qtyLabel = qty != null ? `${fmtQty(qty)} ${coin}` : '—';

  return (
    <div className="mx-auto px-4 py-6" style={{ maxWidth: 640 }}>

      {/* Back nav */}
      <div className="mb-4">
        <Link
          href="/dashboard/funding-arb"
          className="font-body transition-colors duration-100 hover:text-ink"
          style={{ fontSize: 11, color: '#9aa5b3' }}
        >
          ← Back to Funding Rate Monitor
        </Link>
      </div>

      {loading ? (
        <div className="py-20 text-center font-body uppercase tracking-widest text-muted animate-pulse" style={{ fontSize: 10 }}>
          Loading…
        </div>
      ) : !data?.ok ? (
        <div className="py-20 text-center font-body" style={{ fontSize: 11, color: '#e11d48' }}>
          Data unavailable — agent not running.
        </div>
      ) : !spread ? (
        <div className="py-20 text-center space-y-2">
          <div className="font-body" style={{ fontSize: 11, color: '#6b7787' }}>
            Opportunity not found: {coin} · {shortExchange} / {longExchange}
          </div>
          <div className="font-body" style={{ fontSize: 9, color: '#9aa5b3' }}>
            This pair may have dropped out of the current snapshot — check the main list.
          </div>
          <div className="mt-4">
            <Link href="/dashboard/funding-arb" className="font-body" style={{ fontSize: 10, color: '#0f766e' }}>
              ← Return to list
            </Link>
          </div>
        </div>
      ) : (
        <>
          {/* ── SUMMARY STRIP ──────────────────────────────────────────────── */}
          <div className="rounded-card mb-4" style={{ background: '#fff', border: '1px solid #e6eaef', padding: '14px 16px' }}>

            {/* Ticker + status + caption */}
            <div className="flex items-center flex-wrap gap-x-2.5 gap-y-1 mb-3">
              <span className="font-mono font-bold tracking-tight" style={{ fontSize: 20, color: '#0e1626' }}>{coin}</span>
              <span
                className="font-body uppercase tracking-widest"
                style={{
                  fontSize: 8.5, padding: '2px 6px', borderRadius: 4,
                  color: STATUS_STYLE[spread.status].color,
                  background: STATUS_STYLE[spread.status].bg,
                  border: `1px solid ${STATUS_STYLE[spread.status].border}`,
                }}
              >
                {spread.status}
              </span>
              {spread.thinFlag && (
                <span className="font-body" style={{ fontSize: 9, color: '#b45309' }}>⚠ thin</span>
              )}
              <span className="font-body ml-auto" style={{ fontSize: 10, color: '#9aa5b3' }}>{caption}</span>
            </div>

            {/* Leg chips */}
            <div className="flex flex-wrap gap-2 mb-3">
              {([
                ['SHORT', shortExchange, spread.frShort, spread.intervalHoursShort, spread.shortIsDex, shortFlow] as const,
                ['LONG',  longExchange,  spread.frLong,  spread.intervalHoursLong,  spread.longIsDex,  longFlow]  as const,
              ]).map(([side, ex, fr, iv, isDex, flow]) => (
                <div
                  key={side}
                  className="inline-flex items-center gap-1.5 rounded-button"
                  style={{ padding: '6px 10px', border: '1px solid #eef2f6', background: '#fbfcfd' }}
                >
                  <span className="font-body uppercase tracking-wider" style={{ fontSize: 8.5, color: FLOW_COLOR[flow] }}>{side}</span>
                  <PlatformLogo platform={ex} size={12} />
                  <span className="font-mono font-bold" style={{ fontSize: 11, color: '#0e1626' }}>{venueLabel(ex)}{isDex ? ' (DEX)' : ''}</span>
                  <span className="font-mono tabular-nums" style={{ fontSize: 11, color: FLOW_COLOR[flow] }}>
                    {fmtRate8h(fr, iv)}<span style={{ color: '#9aa5b3' }}>/8h</span>
                  </span>
                </div>
              ))}
            </div>

            {/* One-line stat row */}
            <div className="font-mono tabular-nums flex flex-wrap items-center gap-x-2 gap-y-1" style={{ fontSize: 12, color: '#6b7787' }}>
              <span>
                net{' '}
                {isRedacted
                  ? <Redacted value={spread.netApy30d}>{() => null}</Redacted>
                  : <span className="font-bold" style={{ color: '#0e1626' }}>{dayUsd != null ? fmtUsd(dayUsd) : '—'}</span>}
                <span style={{ color: '#9aa5b3' }}>/day</span>
              </span>
              <span style={{ color: '#cbd3dc' }}>·</span>
              <span>
                payback{' '}
                <span style={{ color: '#0e1626' }}>
                  <Redacted value={spread.breakevenDays}>{v => formatPayback(v)}</Redacted>
                </span>
              </span>
              <span style={{ color: '#cbd3dc' }}>·</span>
              <span>
                max{' '}
                <span style={{ color: '#0e1626' }}>
                  {spread.greenCapacityUsd == null
                    ? (isRedacted
                        ? <Redacted value={spread.greenCapacityUsd}>{() => null}</Redacted>
                        : <span style={{ color: '#9aa5b3' }}>n/a</span>)
                    : spread.greenCapacityUsd > 0
                      ? fmtCapDisplay(spread.greenCapacityUsd)
                      : <span style={{ color: '#b45309' }}>too thin</span>}
                </span>
              </span>
            </div>

            {data.staleMinutes != null && data.staleMinutes > 5 && (
              <div className="font-body mt-2" style={{ fontSize: 9, color: '#b45309' }}>
                Data is {data.staleMinutes}m old — rates may have shifted.
              </div>
            )}
          </div>

          {/* ── SIZING + HOW TO EXECUTE (gated) ────────────────────────────── */}
          {isRedacted ? (
            <RedactedPanel
              label="Position sizing and the step-by-step execution guide are available on Pro"
              className="mb-4"
            />
          ) : (
            <>
              {/* Size control */}
              <div className="rounded-card mb-4" style={{ background: '#fff', border: '1px solid #e6eaef', padding: '12px 16px' }}>
                <div className="font-body uppercase tracking-widest mb-2.5" style={{ fontSize: 9, color: '#9aa5b3' }}>Your size</div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="inline-flex items-center gap-1">
                    <span className="font-body" style={{ fontSize: 12, color: '#9aa5b3' }}>$</span>
                    <input
                      type="number" min={0} step={100} value={capital}
                      onChange={e => setCapital(Math.max(0, parseFloat(e.target.value) || 0))}
                      className="font-mono tabular-nums rounded-sm focus:outline-none"
                      style={{ width: 88, padding: '7px 8px', fontSize: 12, border: '1px solid #e6eaef', color: '#0e1626' }}
                    />
                  </div>
                  <div className="inline-flex items-center gap-1">
                    {LEVERAGE_OPTIONS.map(lev => (
                      <button
                        key={lev}
                        onClick={() => setLeverage(lev)}
                        title={lev === 1
                          ? '1× — no leverage; each leg sized to half capital. No liquidation risk from basis moves.'
                          : `${lev}× — both legs use ${lev}× margin. Higher yield, higher liquidation risk.`}
                        className="font-body rounded-sm transition-colors duration-100"
                        style={leverage === lev
                          ? { minWidth: 36, minHeight: 36, fontSize: 11, background: '#0f766e', color: '#fff', border: '1px solid #0f766e' }
                          : { minWidth: 36, minHeight: 36, fontSize: 11, background: '#fff', color: '#6b7787', border: '1px solid #e6eaef' }}
                      >
                        {lev}×
                      </button>
                    ))}
                  </div>
                  {leverage > 1 && (
                    <span className="font-body" style={{ fontSize: 9, color: '#b45309' }}>
                      {leverage}× on both legs — liquidation risk if basis widens
                    </span>
                  )}
                </div>
              </div>

              {/* How to execute */}
              <div className="rounded-card mb-4" style={{ background: '#fff', border: '1px solid #e6eaef', padding: '14px 16px' }}>
                <div className="font-body uppercase tracking-widest mb-3" style={{ fontSize: 9, color: '#9aa5b3' }}>How to execute</div>

                {([
                  {
                    t: 'Size both legs equally',
                    b: <>Split ${capital.toLocaleString()} into <b style={{ color: '#0e1626' }}>{fmtUsd(notionalPerLeg)}</b> per leg ({qtyLabel} each). Equal notional on both sides keeps the position market-neutral.</>,
                  },
                  {
                    t: 'Open short + long together',
                    b: <>SHORT <b style={{ color: '#0e1626' }}>{qtyLabel}</b> on {venueLabel(shortExchange)}, LONG the same on {venueLabel(longExchange)}. Use taker (market/IOC) so both fill now — limit orders can&apos;t guarantee a simultaneous fill.</>,
                  },
                  {
                    t: 'Minimize the gap between fills',
                    b: <>Open both in two tabs (or an automation) so you turn neutral fast. Until the second leg fills, the first is a directional price bet.</>,
                  },
                  {
                    t: 'Collect funding, watch the spread',
                    b: <>Both legs settle funding {settleNote} into your margin. Round-trip fees of <b style={{ color: '#0e1626' }}>{feesUsd != null ? fmtUsd(feesUsd) : '—'}</b> clear in <b style={{ color: '#0e1626' }}>{formatPayback(spread.breakevenDays)}</b>. The rate is a run-rate, not locked — exit both legs (taker) when the spread compresses below ~{effectiveThreshold.toFixed(1)}%/yr or the short-side rate flips.</>,
                  },
                ]).map((step, i, arr) => (
                  <div
                    key={i}
                    className="flex items-start gap-3"
                    style={{ paddingBottom: i < arr.length - 1 ? 12 : 0, marginBottom: i < arr.length - 1 ? 12 : 0, borderBottom: i < arr.length - 1 ? '1px solid #f1f4f7' : 'none' }}
                  >
                    <span className="font-mono shrink-0" style={{ fontSize: 9, padding: '2px 5px', border: '1px solid #e6eaef', color: '#9aa5b3', marginTop: 1 }}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <div className="min-w-0">
                      <div className="font-body font-semibold" style={{ fontSize: 12, color: '#0e1626' }}>{step.t}</div>
                      <p className="font-body mt-0.5 leading-relaxed" style={{ fontSize: 11, color: '#6b7787' }}>{step.b}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── STAY ON TOP OF IT ──────────────────────────────────────────── */}
          <div className="rounded-card mb-4" style={{ background: '#fff', border: '1px solid #e6eaef', padding: '14px 16px' }}>
            <div className="font-body uppercase tracking-widest mb-3" style={{ fontSize: 9, color: '#9aa5b3' }}>Stay on top of it</div>

            {/* Row A — exit alert on Telegram */}
            <div className="flex items-center gap-3" style={{ paddingBottom: 12, marginBottom: 12, borderBottom: '1px solid #f1f4f7' }}>
              <div className="min-w-0 flex-1">
                <div className="font-body font-semibold" style={{ fontSize: 12, color: '#0e1626' }}>Exit alert on Telegram</div>
                <p className="font-body mt-0.5" style={{ fontSize: 10, color: '#6b7787' }}>
                  Ping when yield drops below{' '}
                  <Redacted value={spread.totalFeesPct}>{() => <span className="font-mono">{effectiveThreshold.toFixed(1)}%/yr</span>}</Redacted>
                </p>
              </div>
              <a
                href={tgFollowHref}
                target="_blank"
                rel="noopener noreferrer"
                className="font-body rounded-button shrink-0 transition-colors duration-100 hover:text-white"
                style={{ fontSize: 11, padding: '8px 12px', border: '1px solid #0f766e', color: '#0f766e' }}
              >
                Follow ↗
              </a>
            </div>

            {/* Row B — auto-execute (coming soon, DISABLED placeholder — inert UI) */}
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-body font-semibold" style={{ fontSize: 12, color: '#0e1626' }}>Auto-execute</span>
                  <span
                    className="font-body uppercase tracking-widest"
                    style={{ fontSize: 8, padding: '1px 5px', borderRadius: 4, color: '#b45309', background: '#fdf6ec', border: '1px solid rgba(180,83,9,0.25)' }}
                  >
                    Coming soon
                  </span>
                </div>
                <p className="font-body mt-0.5" style={{ fontSize: 10, color: '#6b7787' }}>
                  Connect API keys, Edgeradar opens both legs for you
                </p>
              </div>
              {/* Presentational only — no handler, not focusable, never places orders. */}
              <div
                role="switch"
                aria-checked={false}
                aria-disabled={true}
                aria-label="Auto-execute — coming soon, not yet available"
                title="Coming soon — not yet available"
                className="relative shrink-0 rounded-full"
                style={{ width: 40, height: 22, background: '#e6eaef', cursor: 'not-allowed', opacity: 0.55 }}
              >
                <span
                  className="absolute rounded-full"
                  style={{ width: 16, height: 16, top: 3, left: 3, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.15)' }}
                />
              </div>
            </div>
          </div>

          {/* ── Disclaimer (one line) ──────────────────────────────────────── */}
          <p className="font-body leading-relaxed" style={{ fontSize: 9, color: '#9aa5b3' }}>
            Alerts are notifications only — they never place, modify, or cancel a position. Execution is entirely at your own risk.
          </p>
        </>
      )}
    </div>
  );
}
