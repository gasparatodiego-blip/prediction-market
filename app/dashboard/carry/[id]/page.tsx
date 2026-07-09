'use client';

// Cash & carry operation (order) page — opened from a carry card. Mirrors the
// funding-arb order-page look and REUSES its shared display helpers
// (@/lib/order-format) + PlatformLink + Redacted, so the two order pages format
// money, capacity and links identically. No new visual style.
//
// Honest-engine: MAX SIZE before slippage is the real book-walked capacity for
// book-sourced venues (capacitySource === 'book', e.g. Bybit) — never OI. For
// proxy venues it is honestly labeled a vol/OI estimate. coinMargined rows keep
// their "USD return drifts with spot" caveat; free-tier redaction is preserved.

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import PlatformLogo from '@/components/PlatformLogo';
import { Redacted, RedactedPanel } from '@/app/components/ui/Redacted';
import { PlatformLink } from '@/app/components/ui/PlatformLink';
import { VerifyBadge } from '@/app/components/ui/VerifyBadge';
import { venueFutureUrl, venueSpotUrl } from '@/lib/platform-links';
import { fmtCapDisplay } from '@/lib/order-format';
import { type Contract, chipVariant, nonCashableReason } from '@/lib/carry';

interface CarryData { opportunities: Contract[]; updatedAt: string | null; }

// Verdict chip palette — mirror of the EdgeChip colours used across the app.
const VERDICT_CHIP: Record<string, { color: string; bg: string; border: string; label: string }> = {
  cashable:    { color: '#0f766e', bg: '#e6f4f1', border: 'rgba(15,118,110,0.25)', label: 'CASHABLE' },
  speculative: { color: '#b45309', bg: '#fdf6ec', border: 'rgba(180,83,9,0.25)',   label: 'SPECULATIVE' },
  signal:      { color: '#6b7787', bg: '#f1f4f7', border: '#cbd3dc',                label: 'SIGNAL' },
};

const APY_CAP = 2.0;
function fmtAnnualized(n: number): string {
  const capped = n > APY_CAP;
  const v = capped ? APY_CAP : n;
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%${capped ? ' †' : ''}`;
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
  const isRedacted = !!c && c.netAnnualizedExecutable == null;
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
              <span>exec basis <span className="font-bold" style={{ color: '#0e1626' }}><Redacted value={c.executableBasisPct}>{v => `+${(v * 100).toFixed(2)}%`}</Redacted></span></span>
              <span style={{ color: '#cbd3dc' }}>·</span>
              <span>net <span className="font-bold" style={{ color: '#0e1626' }}><Redacted value={c.netAnnualizedExecutable}>{v => fmtAnnualized(v)}</Redacted></span><span style={{ color: '#9aa5b3' }}>/yr</span></span>
              <span style={{ color: '#cbd3dc' }}>·</span>
              {/* Real locked return over the actual hold — de-annualized (net × days/365 =
                  executableBasis − fee) so the annualized run-rate isn't read as the
                  short-period gain. Redacts with the net field on free tier. */}
              <span>real <span className="font-bold" style={{ color: '#0e1626' }}><Redacted value={c.netAnnualizedExecutable}>{v => `≈ +${(v * c.daysToExpiry / 365 * 100).toFixed(2)}%`}</Redacted></span><span style={{ color: '#9aa5b3' }}> over {c.daysToExpiry}d</span></span>
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
                  : 'Estimate from 24h volume / open interest — verify real book depth on-exchange before sizing up.'}
              </p>
            )}
          </div>

          {/* ── HOW TO EXECUTE (educational, all tiers) ──────────────────────── */}
          <div className="rounded-card mb-4" style={{ background: '#effcf9', border: '1px solid rgba(15,118,110,0.25)', padding: '12px 14px' }}>
            <div className="font-body font-semibold" style={{ fontSize: 12, color: '#0f766e' }}>Lock the basis: buy spot, short the dated future</div>
            <ol className="font-body mt-1.5 leading-relaxed list-decimal ml-4 space-y-0.5" style={{ fontSize: 11, color: '#0e1626' }}>
              <li>Buy {c.asset} spot on Binance at {spotPx != null ? fmtPrice(spotPx) : 'the ask'}.</li>
              <li>Short the {c.contract} dated future on {venueLabel(c.exchange)} at {futurePx != null ? fmtPrice(futurePx) : 'the bid'} (equal notional).</li>
              <li>Hold both legs to expiry ({c.expiry}) — the future converges to spot and you keep the basis locked at entry.</li>
              {c.coinMargined && <li className="text-gold">This contract settles in {c.asset}, not USD — your USD return drifts with spot. Not a clean locked-USD yield.</li>}
            </ol>

            {/* Automatic venue action buttons — open the REAL venue URL for each leg,
                reusing the shared PlatformLink (non-compact = labeled button), the same
                component the funding-arb / prediction order pages use. */}
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
          </div>

          {/* ── GATED VERDICT ────────────────────────────────────────────────── */}
          {isRedacted ? (
            <RedactedPanel label="The net-of-fees return and executable size are available on Pro" className="mb-4" />
          ) : (
            <div className="rounded-card mb-4" style={{ background: '#fff', border: '1px solid #e6eaef', padding: '12px 14px' }}>
              <p className="font-body leading-relaxed" style={{ fontSize: 12, color: '#6b7787' }}>
                <Redacted value={c.verdict}>{v => v}</Redacted>
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
        </>
      )}
    </div>
  );
}
