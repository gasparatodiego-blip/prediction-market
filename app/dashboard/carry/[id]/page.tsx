'use client';

// Cash & carry operation (order) page — opened from a carry card. Mirrors the
// funding-arb order-page look and REUSES its shared display helpers
// (@/lib/order-format) + PlatformLink + Redacted, so the two order pages format
// money, capacity and links identically. No new visual style.
//
// Honest-engine: MAX SIZE before slippage is the real book-walked capacity —
// every venue is book-walked now, never OI. A contract whose book was unreadable
// has capacitySource 'unknown' and shows "—" rather than an inferred number.
// coinMargined rows keep their "USD return drifts with spot" caveat; free-tier
// redaction is preserved.

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { APY_CAP, APY_CAP_LABEL } from '@/lib/honest-display';
import PlatformLogo from '@/components/PlatformLogo';
import { Redacted, RedactedPanel } from '@/app/components/ui/Redacted';
import { PlatformLink } from '@/app/components/ui/PlatformLink';
import { VerifyBadge } from '@/app/components/ui/VerifyBadge';
import { venueFutureUrl, venueSpotUrl } from '@/lib/platform-links';
import { fmtCapDisplay, fmtMoney } from '@/lib/order-format';
import { type Contract, chipVariant, nonCashableReason } from '@/lib/carry';

interface CarryData { opportunities: Contract[]; updatedAt: string | null; isPaid?: boolean; }

// SAFETY GATE — automated order placement is NOT built yet. While this is false the
// "Execute automatically" button only opens a prepare/confirm modal: it shows what
// WOULD be placed, requests NO API keys, and sends NO order. Any real-execution code
// added later must live behind `if (EXECUTION_ENABLED)` and stays inert until the
// separate security-hardening project flips this on. Do NOT set true without it.
const EXECUTION_ENABLED = false;

// Capital presets for the operation-page size selector — mirrors the inline
// preset-button + editable-input stepper used on the liquidity-rewards and
// funding-arb order pages. Default $10k.
const CAPITAL_PRESETS = [1_000, 5_000, 10_000, 50_000];
const DEFAULT_CAPITAL = 10_000;
// Preset label: "$1k" / "$50k" (matches the rewards stepper's compact label).
function presetLabel(v: number): string {
  return v >= 1_000 ? `$${v / 1_000}k` : `$${v}`;
}

// Verdict chip palette — mirror of the EdgeChip colours used across the app.
const VERDICT_CHIP: Record<string, { color: string; bg: string; border: string; label: string }> = {
  cashable:    { color: '#0f766e', bg: '#e6f4f1', border: 'rgba(15,118,110,0.25)', label: 'CASHABLE' },
  speculative: { color: '#b45309', bg: '#fdf6ec', border: 'rgba(180,83,9,0.25)',   label: 'SPECULATIVE' },
  signal:      { color: '#6b7787', bg: '#f1f4f7', border: '#cbd3dc',                label: 'SIGNAL' },
};

// APY_CAP/APY_CAP_LABEL come from lib/honest-display — the ONE ceiling every surface caps
// and labels against (this page carried its own `const APY_CAP = 2.0` duplicate). The
// shared constant is in PERCENT (200); these fields are fractions (2.0 === 200%/yr).
const APY_CAP_FRAC = APY_CAP / 100;
function fmtAnnualized(n: number): string {
  // Over the ceiling, print it as a BOUND and say what that means. The old code appended a
  // bare "†" whose footnote did not exist anywhere on the page — a mark with no explanation
  // is worse than no mark, so the shared label is rendered beside the figure instead.
  if (n > APY_CAP_FRAC) return `>${APY_CAP}%`;
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
}
/** True when the figure hit the shared ceiling — callers render APY_CAP_LABEL next to it. */
function isApyCapped(n: number | null | undefined): boolean {
  return n != null && Number.isFinite(n) && n > APY_CAP_FRAC;
}
function fmtPrice(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function venueLabel(e: string): string {
  return e.charAt(0).toUpperCase() + e.slice(1);
}
// Fee %: trim trailing zeros but keep enough precision for sub-0.1% legs
// (0.0010 → "0.10%", 0.00055 → "0.055%", 0.00015 → "0.015%").
function fmtFeePct(pct: number): string {
  const v = pct * 100;
  return `${v.toFixed(v < 0.1 ? 3 : 2)}%`;
}

export default function CarryOperationPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);
  // id = "<venueKey>-<contract>" — venueKey never contains a dash (COINM/USDTM/
  // BYBIT/OKX/DERIBIT), so split on the FIRST dash; the contract keeps its own
  // dashes/underscores (BTC-USD-260925, BTCUSDT-25SEP26, BTCUSD_260925).
  const dash = id.indexOf('-');
  const venueKey = dash >= 0 ? id.slice(0, dash) : id;
  const contract = dash >= 0 ? id.slice(dash + 1) : '';

  const [data, setData] = useState<CarryData | null>(null);
  const [loading, setLoading] = useState(true);
  // User capital for the live fee/net-dollar figures (operation page only).
  const [capital, setCapital] = useState(DEFAULT_CAPITAL);
  // Execute button → prepare/confirm modal (no live trading; see EXECUTION_ENABLED).
  const [showExecModal, setShowExecModal] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/carry', { cache: 'no-store' });
      setData(await res.json());
    } catch { /* keep stale */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const c = data?.opportunities?.find(o => o.venueKey === venueKey && o.contract === contract) ?? null;
  // Paid tier (server-derived). A paid user is never behind the paywall, so gate on
  // the real flag — NOT on "net is null", which falsely paywalls a pro user whenever
  // the honest-engine guardian legitimately suppresses a field (e.g. OI/proxy capacity).
  // Genuinely-null gated fields then show honest "—" (via isPaid on <Redacted>), not a lock.
  const isPaid = data?.isPaid ?? false;
  const isRedacted = !!c && !isPaid;
  const spotPx   = c?.spotAsk  ?? c?.spot   ?? null;
  const futurePx = c?.futureBid ?? c?.future ?? null;
  const venueUrl = c ? venueFutureUrl(c.venueKey || c.exchange, c.contract) : null;
  // Spot leg is bought on Binance for every venue (agent19-basis prices spot off
  // Binance) — real spot URL for the buy leg.
  const spotUrl = c ? venueSpotUrl('binance', c.asset) : null;
  // Cashable/speculative verdict + its honest reason — same SSOT as the list
  // (lib/carry). On free tier the edge is redacted → variant is 'signal'.
  const variant = c ? chipVariant(c) : 'signal';
  const reason  = c ? nonCashableReason(c) : null;
  const vchip   = VERDICT_CHIP[variant] ?? VERDICT_CHIP.signal;

  // Redaction-aware display strings for the step guide + execute modal. Real data
  // only — a free-tier-redacted (null) or genuinely-missing field renders "—",
  // never a fabricated figure (honest-engine). Basis/net/capacity are gated fields.
  const basisStr = c?.executableBasisPct != null ? `+${(c.executableBasisPct * 100).toFixed(2)}%` : '—';
  const netStr   = c?.netAnnualizedExecutable != null ? fmtAnnualized(c.netAnnualizedExecutable) : '—';
  const capStr   = c?.capacityUsd != null && c.capacityUsd > 0 ? fmtCapDisplay(c.capacityUsd) : '—';

  // Numbered execution steps, built from THIS opportunity's real fields.
  const steps = c ? [
    { tag: 'SPOT',  title: 'Buy the spot',         body: `Buy ${c.asset} at spot on Binance${spotPx != null ? ` (~${fmtPrice(spotPx)})` : ''}, up to ~${capStr}.` },
    { tag: 'SHORT', title: 'Open the short',        body: `Short ${c.contract} on ${venueLabel(c.exchange)}${futurePx != null ? ` (~${fmtPrice(futurePx)})` : ''}, same size — this locks ${basisStr} basis.` },
    { tag: 'HOLD',  title: 'Hold to expiry',        body: `Keep both legs to ${c.expiry} (${c.daysToExpiry}d); the two prices move to offset each other.` },
    { tag: 'CASH',  title: 'Collect at settlement', body: `The future converges to spot and cash-settles — you keep ~${netStr}/yr net-of-fee.` },
  ] : [];

  // Copy the two legs as plain text for manual placement. PREPARE-MODE ONLY: no API
  // keys, no order submission. The real-execution path is gated off (EXECUTION_ENABLED)
  // and inert here — it will be built in the later security-hardening project.
  const copyOrderDetails = () => {
    if (!c) return;
    const lines = [
      `Cash & carry — ${c.asset}`,
      `1) BUY SPOT: ${c.asset} on Binance${spotPx != null ? ` @ ${fmtPrice(spotPx)}` : ''}`,
      `2) SHORT:    ${c.contract} on ${venueLabel(c.exchange)}${futurePx != null ? ` @ ${fmtPrice(futurePx)}` : ''}`,
      `Same size · basis ${basisStr} · net ${netStr}/yr · hold to ${c.expiry} (${c.daysToExpiry}d)`,
    ];
    if (EXECUTION_ENABLED) { /* real automated placement — added later, behind the gate; inert now */ }
    try { navigator.clipboard?.writeText(lines.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable — no-op */ }
  };

  return (
    <div className="max-w-[720px] mx-auto px-4 py-6">
      <div className="mb-4">
        <Link href="/dashboard/carry" className="font-body transition-colors duration-100 hover:text-ink" style={{ fontSize: 11, color: '#9aa5b3' }}>
          ← Back to Cash &amp; Carry
        </Link>
      </div>

      {loading && !data ? (
        <div className="py-20 text-center font-body uppercase tracking-widest text-muted animate-pulse" style={{ fontSize: 10 }}>Loading…</div>
      ) : !c ? (
        <div className="py-20 text-center space-y-2">
          <div className="font-body" style={{ fontSize: 11, color: '#6b7787' }}>Contract not found: {venueKey} · {contract}</div>
          <div className="font-body" style={{ fontSize: 9, color: '#9aa5b3' }}>It may have dropped out of the current snapshot — check the main list.</div>
          <div className="mt-4"><Link href="/dashboard/carry" className="font-body" style={{ fontSize: 10, color: '#0f766e' }}>← Return to list</Link></div>
        </div>
      ) : (
        <>
          {/* ── CAPITAL SELECTOR + LIVE DOLLAR FIGURES (operation page only) ───────
              Honest-engine: the net dollar gain multiplies capital by the REAL
              PERIOD return (executableBasisPct − full 4-leg round-trip fee), NOT
              the annualized %/yr. Fees in $ scale with the same real fee. On free
              tier the underlying % is redacted (null) → the $ figures withhold too
              (gated by isRedacted), never fabricated. */}
          <div className="rounded-card mb-4" style={{ background: '#fff', border: '1px solid #e6eaef', padding: '14px 16px' }}>
            <div className="font-body uppercase tracking-widest mb-2.5" style={{ fontSize: 9, color: '#9aa5b3' }}>Your capital</div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
              {CAPITAL_PRESETS.map(v => (
                <button
                  key={v}
                  onClick={() => setCapital(v)}
                  className="font-body rounded-sm transition-colors duration-100"
                  style={capital === v
                    ? { minWidth: 44, padding: '7px 10px', fontSize: 12, background: '#0f766e', color: '#fff', border: '1px solid #0f766e' }
                    : { minWidth: 44, padding: '7px 10px', fontSize: 12, background: '#fff', color: '#6b7787', border: '1px solid #e6eaef' }}
                >
                  {presetLabel(v)}
                </button>
              ))}
              <div className="inline-flex items-center gap-1">
                <span className="font-body" style={{ fontSize: 12, color: '#9aa5b3' }}>$</span>
                <input
                  type="number" min={0} step={1000} value={capital}
                  onChange={e => setCapital(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="font-mono tabular-nums rounded-sm focus:outline-none"
                  style={{ width: 100, padding: '7px 8px', fontSize: 12, border: '1px solid #e6eaef', color: '#0e1626' }}
                />
              </div>
            </div>

            {/* Over-capacity warning — honest: never fabricate depth. capacityUsd is
                the real book-walked max size for book-sourced venues. */}
            {c.capacityUsd != null && c.capacityUsd > 0 && capital > c.capacityUsd && (
              <div className="mt-2.5 px-3 py-2 rounded-md font-body" style={{ fontSize: 11, color: '#b45309', background: '#fff8ef', border: '1px solid rgba(180,83,9,.25)' }}>
                {fmtMoney(capital)} sopra la max size ({fmtCapDisplay(c.capacityUsd)}) — oltre rischi slippage: il book potrebbe non riempirsi a questo prezzo. Riduci e scala in.
              </div>
            )}

            {/* Live dollar figures — recompute from selected capital */}
            <div className="mt-3 pt-3" style={{ borderTop: '1px solid #eef2f6' }}>
              {isRedacted ? (
                <RedactedPanel label="The dollar fees and net gain are available on Pro" />
              ) : (
                <div className="flex flex-wrap gap-x-6 gap-y-2.5">
                  {/* Gross gain (period, before fees) */}
                  <div className="flex flex-col">
                    <span className="font-body uppercase tracking-wide" style={{ fontSize: 8.5, color: '#9aa5b3' }}>Gross gain · {c.daysToExpiry}d</span>
                    <span className="font-mono font-bold tabular-nums" style={{ fontSize: 15, color: '#0e1626' }}>
                      {fmtMoney(capital * (c.executableBasisPct ?? 0))}
                    </span>
                  </div>
                  {/* Total round-trip fees (4-leg) */}
                  <div className="flex flex-col">
                    <span className="font-body uppercase tracking-wide" style={{ fontSize: 8.5, color: '#9aa5b3' }}>Fees (round-trip)</span>
                    <span className="font-mono font-bold tabular-nums" style={{ fontSize: 15, color: '#b45309' }}>
                      −{fmtMoney(capital * c.fee)}
                    </span>
                  </div>
                  {/* NET GAIN IN POCKET — real PERIOD return in dollars, not annualized */}
                  <div className="flex flex-col">
                    <span className="font-body uppercase tracking-wide" style={{ fontSize: 8.5, color: '#0f766e' }}>Netto in tasca · {c.daysToExpiry}d</span>
                    <span className="font-mono font-bold tabular-nums" style={{ fontSize: 18, color: '#0f766e' }}>
                      {fmtMoney(capital * ((c.executableBasisPct ?? 0) - c.fee))}
                    </span>
                  </div>
                </div>
              )}
              {!isRedacted && (
                <p className="font-body mt-2 leading-snug" style={{ fontSize: 9.5, color: '#9aa5b3' }}>
                  Net = capital × (exec basis − fee) over {c.daysToExpiry}d — the real return locked only if held to expiry ({c.expiry}), not annualized and not guaranteed if closed early.
                </p>
              )}
            </div>
          </div>

          {/* ── SUMMARY STRIP ─────────────────────────────────────────────────── */}
          <div className="rounded-card mb-4" style={{ background: '#fff', border: '1px solid #e6eaef', padding: '14px 16px' }}>
            <div className="flex items-center flex-wrap gap-x-2.5 gap-y-1 mb-3">
              <span className="font-mono font-bold tracking-tight" style={{ fontSize: 20, color: '#0e1626' }}>{c.asset}</span>
              {/* Primary verdict — cashable / speculative / signal (same rule as the list) */}
              <span className="font-body uppercase tracking-widest" style={{ fontSize: 8.5, padding: '2px 6px', borderRadius: 4, color: vchip.color, background: vchip.bg, border: `1px solid ${vchip.border}` }}>
                {vchip.label}
              </span>
              {/* Settlement class */}
              <span className="font-body uppercase tracking-widest" style={{ fontSize: 8.5, padding: '2px 6px', borderRadius: 4, color: c.coinMargined ? '#b45309' : '#0f766e', background: c.coinMargined ? '#fff8ef' : '#effcf9', border: `1px solid ${c.coinMargined ? 'rgba(180,83,9,.25)' : 'rgba(15,118,110,.25)'}` }}>
                {c.coinMargined ? 'COIN-SETTLED' : 'CLEAN USD'}
              </span>
              <span className="font-body ml-auto" style={{ fontSize: 10, color: '#9aa5b3' }}>{c.contract} · {c.daysToExpiry}d to expiry</span>
            </div>

            {/* Leg chips: buy spot (long) + short dated future */}
            <div className="flex flex-wrap gap-2 mb-3">
              <div className="inline-flex items-center gap-1.5 rounded-button" style={{ padding: '6px 10px', border: '1px solid #eef2f6', background: '#fbfcfd' }}>
                <span className="font-body uppercase tracking-wider" style={{ fontSize: 8.5, color: '#0f766e' }}>BUY SPOT</span>
                <PlatformLogo platform="binance" size={12} />
                <span className="font-mono font-bold" style={{ fontSize: 11, color: '#0e1626' }}>Binance</span>
                <span className="font-mono tabular-nums" style={{ fontSize: 11, color: '#0e1626' }}>{spotPx != null ? fmtPrice(spotPx) : '—'}</span>
              </div>
              <div className="inline-flex items-center gap-1.5 rounded-button" style={{ padding: '6px 10px', border: '1px solid #eef2f6', background: '#fbfcfd' }}>
                <span className="font-body uppercase tracking-wider" style={{ fontSize: 8.5, color: '#e11d48' }}>SHORT FUT</span>
                <PlatformLogo platform={c.exchange} size={12} />
                <span className="font-mono font-bold" style={{ fontSize: 11, color: '#0e1626' }}>{venueLabel(c.exchange)}</span>
                <span className="font-mono tabular-nums" style={{ fontSize: 11, color: '#0e1626' }}>{futurePx != null ? fmtPrice(futurePx) : '—'}</span>
              </div>
            </div>

            {/* One-line stat row: exec basis · net/yr · fee round-trip */}
            <div className="font-mono tabular-nums flex flex-wrap items-center gap-x-2 gap-y-1" style={{ fontSize: 12, color: '#6b7787' }}>
              <span>exec basis <span className="font-bold" style={{ color: '#0e1626' }}><Redacted value={c.executableBasisPct} isPaid={isPaid}>{v => `+${(v * 100).toFixed(2)}%`}</Redacted></span></span>
              <span style={{ color: '#cbd3dc' }}>·</span>
              <span>net <span className="font-bold" style={{ color: '#0e1626' }}><Redacted value={c.netAnnualizedExecutable} isPaid={isPaid}>{v => fmtAnnualized(v)}</Redacted></span><span style={{ color: '#9aa5b3' }}>/yr</span></span>
              {/* Over the shared ceiling the figure is a bound, so say what the bound means
                  right next to it — the number alone would read as a yield we stand behind. */}
              {!isRedacted && isApyCapped(c.netAnnualizedExecutable) && (
                <span className="font-body" style={{ fontSize: 10, color: '#b45309' }}>{APY_CAP_LABEL}</span>
              )}
              <span style={{ color: '#cbd3dc' }}>·</span>
              {/* Real locked return over the actual hold — de-annualized (net × days/365 =
                  executableBasis − fee) so the annualized run-rate isn't read as the
                  short-period gain. Redacts with the net field on free tier. */}
              <span>real <span className="font-bold" style={{ color: '#0e1626' }}><Redacted value={c.netAnnualizedExecutable} isPaid={isPaid}>{v => `≈ +${(v * c.daysToExpiry / 365 * 100).toFixed(2)}%`}</Redacted></span><span style={{ color: '#9aa5b3' }}> over {c.daysToExpiry}d</span></span>
              <span style={{ color: '#cbd3dc' }}>·</span>
              <span>
                fee <span style={{ color: '#0e1626' }}>{(c.fee * 100).toFixed(3)}%</span> round-trip
                {c.feeLegs && c.feeLegs.length > 0 && (
                  <span style={{ color: '#9aa5b3' }}> ({c.feeLegs.map(l => `${l.label} ${fmtFeePct(l.pct)}`).join(' + ')})</span>
                )}
              </span>
            </div>
            <div className="mt-2"><VerifyBadge v={(c as any).__verify} /></div>
          </div>

          {/* ── WHY SPECULATIVE (honest, Phase-0 reason) ─────────────────────── */}
          {reason && (
            <div className="rounded-card mb-4" style={{ background: '#fdf6ec', border: '1px solid rgba(180,83,9,0.25)', padding: '12px 14px' }}>
              <div className="font-body font-semibold" style={{ fontSize: 12, color: '#b45309' }}>
                Why this isn&apos;t a locked cashable trade
              </div>
              <p className="font-body mt-1 leading-relaxed" style={{ fontSize: 11, color: '#0e1626' }}>
                {reason}
              </p>
            </div>
          )}

          {/* ── MAX EXECUTABLE SIZE ───────────────────────────────────────────── */}
          <div className="rounded-card mb-4" style={{ background: '#fff', border: '1px solid #e6eaef', padding: '12px 14px' }}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-body" style={{ fontSize: 11, color: '#6b7787' }}>Max size before slippage</span>
              <span className="font-mono font-bold tabular-nums shrink-0" style={{ fontSize: 14 }}>
                {isRedacted ? (
                  <Redacted value={c.capacityUsd}>{() => null}</Redacted>
                ) : c.capacityUsd == null || c.capacityUsd <= 0 ? (
                  <span className="font-body font-normal" style={{ fontSize: 11, color: '#9aa5b3' }}>not available for this book</span>
                ) : (
                  <span style={{ color: '#0e1626' }}>{fmtCapDisplay(c.capacityUsd)}</span>
                )}
              </span>
            </div>
            {!isRedacted && c.capacityUsd != null && c.capacityUsd > 0 && (
              <p className="font-body mt-1 leading-snug" style={{ fontSize: 10, color: '#9aa5b3' }}>
                {c.capacitySource === 'book'
                  ? 'Walked from the live order book (real resting depth), never OI — start here and scale in.'
                  : 'No measured depth this cycle — capacity is not shown rather than inferred from volume or OI.'}
              </p>
            )}
          </div>

          {/* ── STEP-BY-STEP EXECUTION GUIDE (educational, all tiers) ──────────
              Replaces the old one-line how-to. A numbered vertical stepper built
              from THIS opportunity's real data; redacted/missing fields → "—". */}
          <div className="rounded-card mb-4" style={{ background: '#effcf9', border: '1px solid rgba(15,118,110,0.25)', padding: '14px 16px' }}>
            <div className="font-body font-semibold mb-3" style={{ fontSize: 12, color: '#0f766e' }}>Lock the basis: buy spot, short the dated future</div>

            <ol className="space-y-3">
              {steps.map((s, i) => (
                <li key={s.tag} className="flex gap-3">
                  <div className="flex flex-col items-center shrink-0">
                    <span className="grid place-items-center rounded-full font-mono font-bold" style={{ width: 22, height: 22, fontSize: 11, color: '#fff', background: '#0f766e' }}>{i + 1}</span>
                    {i < steps.length - 1 && <span style={{ width: 1, flex: 1, minHeight: 12, marginTop: 2, background: 'rgba(15,118,110,0.25)' }} />}
                  </div>
                  <div className="pb-0.5">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <span className="font-body font-semibold" style={{ fontSize: 11.5, color: '#0e1626' }}>{s.title}</span>
                      <span className="font-body uppercase tracking-wider" style={{ fontSize: 8, padding: '1.5px 5px', borderRadius: 3, color: '#0f766e', background: '#d7f0ea', border: '1px solid rgba(15,118,110,0.2)' }}>{s.tag}</span>
                    </div>
                    <p className="font-body leading-relaxed" style={{ fontSize: 11, color: '#40505f' }}>{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            {/* Payoff highlight + honest caveat */}
            <div className="mt-3.5 pt-3.5" style={{ borderTop: '1px solid rgba(15,118,110,0.15)' }}>
              <div className="rounded-md" style={{ background: '#d7f0ea', border: '1px solid rgba(15,118,110,0.2)', padding: '8px 12px' }}>
                <span className="font-body font-semibold" style={{ fontSize: 12, color: '#0f766e' }}>
                  Locked {netStr}/yr if held to {c.expiry} — deterministic
                </span>
              </div>
              <p className="font-body mt-2 leading-relaxed" style={{ fontSize: 10, color: '#9aa5b3' }}>
                Run-rate, not guaranteed if you exit early. Both legs are placed together and held; capacity ~{capStr} from order-book depth.
                {c.coinMargined ? ` This contract settles in ${c.asset}, not USD — your USD return drifts with spot, so it is not a clean locked-USD yield.` : ''} Not financial advice.
              </p>
            </div>

            {/* Manual venue action buttons — open the REAL venue URL for each leg
                (shared PlatformLink, same component as the funding-arb order page). */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 pt-3" style={{ borderTop: '1px solid rgba(15,118,110,0.15)' }}>
              <span className="inline-flex items-center gap-1.5">
                <span className="font-body" style={{ fontSize: 10, color: '#6b7787' }}>Buy spot on Binance</span>
                {spotUrl
                  ? <PlatformLink href={spotUrl} label={`Binance ${c.asset} spot`} />
                  : <span className="font-body" style={{ fontSize: 10, color: '#9aa5b3' }}>link unavailable</span>}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="font-body" style={{ fontSize: 10, color: '#6b7787' }}>Short {c.contract} on {venueLabel(c.exchange)}</span>
                {venueUrl
                  ? <PlatformLink href={venueUrl} label={`${venueLabel(c.exchange)} ${c.contract}`} />
                  : <span className="font-body" style={{ fontSize: 10, color: '#9aa5b3' }}>link unavailable</span>}
              </span>
            </div>

            {/* Execute button — SAFE prepare-mode. Opens a confirm modal only; places
                no order and requests no API keys while EXECUTION_ENABLED is false. */}
            <div className="mt-3.5 pt-3.5" style={{ borderTop: '1px solid rgba(15,118,110,0.15)' }}>
              <button
                onClick={() => setShowExecModal(true)}
                className="w-full font-body font-semibold rounded-button transition-colors duration-100"
                style={{ padding: '10px 16px', fontSize: 12.5, color: '#fff', background: '#0f766e', border: '1px solid #0f766e' }}
              >
                Execute automatically
              </button>
              <p className="font-body text-center mt-1.5" style={{ fontSize: 9, color: '#9aa5b3' }}>
                Prepare mode — opens a confirmation, places no orders and requests no API keys.
              </p>
            </div>
          </div>

          {/* ── GATED VERDICT ────────────────────────────────────────────────── */}
          {isRedacted ? (
            <RedactedPanel label="The net-of-fees return and executable size are available on Pro" className="mb-4" />
          ) : (
            <div className="rounded-card mb-4" style={{ background: '#fff', border: '1px solid #e6eaef', padding: '12px 14px' }}>
              <p className="font-body leading-relaxed" style={{ fontSize: 12, color: '#6b7787' }}>
                <Redacted value={c.verdict} isPaid={isPaid}>{v => v}</Redacted>
              </p>
              {c.coinMargined && (
                <div className="mt-2 px-3 py-2 rounded-md font-body" style={{ fontSize: 12, color: '#b45309', background: '#fff8ef', border: '1px solid rgba(180,83,9,.25)' }}>
                  Coin-settled: USD return drifts with spot price — this is not a locked USD yield.
                  {c.coinMarginedNote ? ` ${c.coinMarginedNote}` : ''}
                </div>
              )}
            </div>
          )}

          {data?.updatedAt && (
            <div className="font-body text-center" style={{ fontSize: 9, color: '#9aa5b3' }}>
              Snapshot {new Date(data.updatedAt).toLocaleTimeString('en-GB')} · refreshes every 30s
            </div>
          )}

          {/* ── EXECUTE — PREPARE/CONFIRM MODAL (no live trading) ───────────────
              Shows exactly what WOULD be placed, states execution is not enabled,
              offers copy + a venue deep-link. No API key requested, no order sent —
              the live path is gated behind EXECUTION_ENABLED (false) and inert. */}
          {showExecModal && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center px-4"
              style={{ background: 'rgba(14,22,38,0.35)' }}
              onClick={() => setShowExecModal(false)}
              role="dialog" aria-modal="true"
            >
              <div
                className="rounded-card w-full max-w-[440px]"
                style={{ background: '#fff', border: '1px solid #e6eaef', boxShadow: '0 12px 40px rgba(14,22,38,0.18)' }}
                onClick={e => e.stopPropagation()}
              >
                <div style={{ padding: '16px 18px' }}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-body font-semibold" style={{ fontSize: 13, color: '#0e1626' }}>Confirm cash &amp; carry — prepare</span>
                    <button onClick={() => setShowExecModal(false)} className="font-body" style={{ fontSize: 18, lineHeight: 1, color: '#9aa5b3' }} aria-label="Close">×</button>
                  </div>

                  {/* (a) exactly what WOULD be placed */}
                  <div className="rounded-md mb-3" style={{ background: '#fbfcfd', border: '1px solid #eef2f6', padding: '10px 12px' }}>
                    <div className="font-body uppercase tracking-wider mb-2" style={{ fontSize: 8.5, color: '#9aa5b3' }}>What would be placed</div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="font-body uppercase tracking-wider shrink-0" style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, color: '#0f766e', background: '#d7f0ea' }}>BUY SPOT</span>
                      <span className="font-mono" style={{ fontSize: 11, color: '#0e1626' }}>Buy {c.asset} spot on Binance{spotPx != null ? ` @ ${fmtPrice(spotPx)}` : ''}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-body uppercase tracking-wider shrink-0" style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, color: '#e11d48', background: '#fdeef1' }}>SHORT</span>
                      <span className="font-mono" style={{ fontSize: 11, color: '#0e1626' }}>Short {c.contract} on {venueLabel(c.exchange)}{futurePx != null ? ` @ ${fmtPrice(futurePx)}` : ''}</span>
                    </div>
                    <div className="font-body mt-2" style={{ fontSize: 10, color: '#6b7787' }}>Same size, at {basisStr} basis · net {netStr}/yr held to {c.expiry}.</div>
                  </div>

                  {/* (b) execution-not-enabled notice */}
                  <div className="rounded-md mb-3" style={{ background: '#fff8ef', border: '1px solid rgba(180,83,9,0.25)', padding: '10px 12px' }}>
                    <p className="font-body leading-relaxed" style={{ fontSize: 11, color: '#b45309' }}>
                      Execution not yet enabled — automated placement is coming after security hardening. For now, place these two legs manually on {venueLabel(c.exchange)}.
                    </p>
                  </div>

                  {/* (c) copy + venue deep-link — no order fires, no API key */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={copyOrderDetails}
                      className="font-body font-semibold rounded-button transition-colors duration-100"
                      style={{ padding: '8px 12px', fontSize: 11, color: '#fff', background: '#0f766e', border: '1px solid #0f766e' }}
                    >
                      {copied ? 'Copied ✓' : 'Copy order details'}
                    </button>
                    {venueUrl && <PlatformLink href={venueUrl} label={`Open ${venueLabel(c.exchange)}`} />}
                    <button onClick={() => setShowExecModal(false)} className="font-body ml-auto transition-colors duration-100 hover:text-ink" style={{ fontSize: 11, color: '#6b7787' }}>Close</button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
