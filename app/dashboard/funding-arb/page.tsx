'use client';

import { useEffect, useState, useCallback, useRef, useMemo, Fragment } from 'react';
import Link from 'next/link';
import SectionHelp from '@/app/components/SectionHelp';
import PlatformLogo from '@/components/PlatformLogo';
import {
  type FuturesCoin,
  type SlipPoint,
  type SpreadItem,
  type RwaObservation,
  type Leverage,
  calcSpreadSizing,
} from '@/lib/spread-types';
import { APY_CAP, isOverApyCap } from '@/lib/honest-display';
import { Redacted } from '@/app/components/ui/Redacted';
import { PlatformLink } from '@/app/components/ui/PlatformLink';
import { venuePerpUrl, venueSpotUrl } from '@/lib/platform-links';
import { AUTO_EXECUTE_ENABLED } from '@/lib/flags';
import type { PerpSpotRow, PerpSpotRegime } from '@/lib/spread-types';

// ── Types ─────────────────────────────────────────────────────────────────────

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
  rwa?:         RwaObservation[];
  perpSpot?:    PerpSpotRow[];
  perpSpotStale?: boolean;
  perpSpotRegime?: PerpSpotRegime | null;
  meta:         Meta | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRate(fr: number, intervalHours?: number): string {
  const sign   = fr >= 0 ? '+' : '';
  const suffix = intervalHours === 1 ? '/hr' : '/8h';
  return `${sign}${fr.toFixed(4)}%${suffix}`;
}

function fmtApy(n: number): string {
  // Honest-engine: annualized figures are demoted run-rate and capped at APY_CAP.
  // Above the cap show a ceiling, never a raw inflated number (see the table's
  // run-rate footnote). Reuses the shared isOverApyCap/APY_CAP from honest-display.
  if (isOverApyCap(n)) return `>${APY_CAP}%/yr`;
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

// Full max-executable figure with thousands separators (e.g. "~$45,320"). The
// "~" signals it's an order-book estimate, not a promise. Used for the capacity
// row value when there is real green capacity (case A).
function fmtCapFull(n: number): string {
  return `~$${Math.round(n).toLocaleString('en-US')}`;
}

// Top rung of agent15's SIZE_LADDER ($500k). greenCapacityUsd is walked over that
// discrete ladder, so a pair that reports exactly this value has simply cleared the
// top rung — its true book depth is >= $500k and can be far larger. Mirror of the
// SIZE_LADDER top in agents/agent15-funding-writer.js; keep in sync if the ladder grows.
const SIZE_LADDER_TOP_RUNG = 500_000;

// Compact floor label for the top rung, e.g. "$500k+".
function fmtCapFloor(): string {
  return `$${Math.round(SIZE_LADDER_TOP_RUNG / 1_000)}k+`;
}

// Honest capacity display. Below the ladder top rung the value is a real order-book
// estimate → keep the "~$N" form. At/above the top rung the book is deeper than we
// measure, so an exact "$500,000" would understate deep books — show a truthful
// lower-bound floor ("$500k+", no "~": it's at least this much) instead.
function fmtCapDisplay(n: number): string {
  return n >= SIZE_LADDER_TOP_RUNG ? fmtCapFloor() : fmtCapFull(n);
}

// Three display cases for the capacity row, decided STRICTLY from real fields —
// never a fabricated number. A: real green capacity (gc > 0). B: order book was
// measured (both legs verified, slipCurve present) but no size clears the 30%
// slippage threshold ($0 green) → "too thin". C: capacity was never measured
// (null / key-missing / oneLegUnverified) → "not available yet". Shared by the
// card row, the list cell, and the secondary sort so all three stay in lockstep.
function capCase(s: SpreadItem): 'A' | 'B' | 'C' {
  const gc = s.greenCapacityUsd;
  if (gc != null && gc > 0) return 'A';
  if (gc === 0 && s.oneLegUnverified === false &&
      Array.isArray(s.slipCurve) && s.slipCurve.length > 0) return 'B';
  return 'C';
}

// Sort weight for the secondary tie-break: scalable (A) above measured-thin (B)
// above unmeasured (C). Higher wins.
function capRank(s: SpreadItem): number {
  const c = capCase(s);
  return c === 'A' ? 2 : c === 'B' ? 1 : 0;
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
  if (exchange === 'edgex')       return 'edgeX';
  if (exchange === 'gateio')      return 'Gate.io';
  if (exchange === 'bitget')      return 'Bitget';
  return capFirst(exchange);
}

// ── Sizing ────────────────────────────────────────────────────────────────────

const LEVERAGE_OPTIONS: Leverage[] = [1, 2, 3, 5];

// ── Arb-type filter ───────────────────────────────────────────────────────────

type ArbType = 'all' | 'perp_perp' | 'spot_perp';

function TypeFilterToggle({
  value, onChange,
}: { value: ArbType; onChange: (v: ArbType) => void }) {
  const opts: { id: ArbType; label: string; disabled?: boolean; hint?: string; whyDisabled?: string }[] = [
    { id: 'all',       label: 'All' },
    { id: 'perp_perp', label: 'Perp / Perp' },
    {
      id: 'spot_perp', label: 'Perp vs Spot',
      hint: 'earn the funding',
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
              <span className="ml-1 text-[7px] text-muted/40 align-middle">{opt.hint}</span>
            )}
          </button>
        ))}
      </div>
      {value === 'perp_perp' && (
        <span className="font-body text-[11px] text-muted">
          Short one perp, long another — collect the funding differential
        </span>
      )}
      {value === 'spot_perp' && (
        <span className="font-body text-[11px] text-muted">
          Hold spot, short its perp — collect the full funding rate
        </span>
      )}
    </div>
  );
}

// ── Asset-class selector ──────────────────────────────────────────────────────
// Display/routing only: partitions the already-computed rows into Crypto (data.spreads)
// vs Commodities (data.rwa, observation-only). Stocks disabled — not ingested yet.
type AssetClassView = 'crypto' | 'commodity';
const ASSET_CLASS_STORAGE_KEY = 'edgeradar.funding.assetClass';

function AssetClassToggle({ value, onChange }: { value: AssetClassView; onChange: (v: AssetClassView) => void }) {
  const opts: { id: string; label: string; disabled?: boolean; hint?: string; whyDisabled?: string }[] = [
    { id: 'crypto',    label: 'Crypto' },
    { id: 'commodity', label: 'Commodities' },
    {
      id: 'stock', label: 'Stocks', disabled: true, hint: 'coming soon',
      whyDisabled: 'Stock perpetuals are not ingested yet — they need market-hours gating. Coming soon.',
    },
  ];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="font-body text-[11px] uppercase tracking-wide text-muted shrink-0">
        Asset class
      </span>
      <div className="flex border border-line rounded-button overflow-hidden font-body text-[11px] divide-x divide-line">
        {opts.map(opt => (
          <button
            key={opt.id}
            disabled={!!opt.disabled}
            onClick={() => !opt.disabled && onChange(opt.id as AssetClassView)}
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
              <span className="ml-1 text-[7px] text-muted/40 align-middle">{opt.hint}</span>
            )}
          </button>
        ))}
      </div>
      {value === 'commodity' && (
        <span className="font-body text-[11px] text-muted">
          Observation only — funding is flat/near-zero, not cashable yet
        </span>
      )}
    </div>
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

// ── Redesign: shared display helpers ─────────────────────────────────────────

// Shared payback formatter — the ONLY copy, used on every surface. Under 24h →
// "12h"; ≥24h → "2d 10h" (drops the hours when exact → "3d"); missing/null → "—".
function formatPayback(days: number | null | undefined): string {
  if (days == null || !isFinite(days)) return '—';
  const h = Math.round(days * 24);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24), r = h % 24;
  return r === 0 ? `${d}d` : `${d}d ${r}h`;
}

// Normalize any leg's native funding rate onto a common %/8h basis so CEX (8h)
// and DEX (1h) rates are directly comparable. DISPLAY ONLY — never feeds math.
function rate8h(rateNative: number, intervalHours: number | undefined): number {
  const iv = intervalHours && intervalHours > 0 ? intervalHours : 8;
  return rateNative * (8 / iv);
}
function fmtRate8h(rateNative: number, intervalHours: number | undefined): string {
  const v = rate8h(rateNative, intervalHours);
  return `${v >= 0 ? '+' : ''}${v.toFixed(4)}%`;
}

// ── Per-leg next-funding countdown (display only) ──────────────────────────────
// Each venue settles funding on its OWN cadence (HL/dYdX 1h, edgeX 4h, CEX/Paradex/
// Aster/Grvt 8h), so each leg gets its own clock — never a shared "CEX vs DEX" clock.
// Resolution order, most-honest first:
//   (a) the venue's real next-funding timestamp captured from its API (accounts for
//       any schedule offset), else
//   (b) a UTC-day-aligned boundary computed from intervalHours — multiples of the
//       interval measured from the UTC epoch land on 00:00-UTC-aligned boundaries for
//       intervals that divide 24h (1/4/8), valid for the standard venues in this
//       pipeline (approximation dated 2026-07-04), else
//   (c) null → render nothing (unknown interval AND timestamp — never fabricate).
function nextFundingAt(nextFundingTime: number | undefined, intervalHours: number | undefined, now: number): number | null {
  if (typeof nextFundingTime === 'number' && nextFundingTime > now) return nextFundingTime;   // (a)
  const iv = intervalHours && intervalHours > 0 ? intervalHours : null;
  if (iv == null) return null;                                                                 // (c)
  const ms = iv * 3_600_000;
  return Math.ceil((now + 1) / ms) * ms;                                                       // (b)
}

function fmtCountdown(ms: number, withSeconds: boolean): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return withSeconds ? `${p(h)}:${p(m)}:${p(s)}` : `${p(h)}:${p(m)}`;
}

// One 1s ticker per mounted countdown, cleared on unmount (no per-row timer leak).
function useNowTick(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// Shared by Cards + List + table. Renders nothing when the leg's cadence is unknown
// (path c). Distinct from the global CEX/HL summary clock FundingCountdown({targetMs}).
// prefers-reduced-motion: the digits still update (it's information, not decoration).
function LegFundingCountdown({
  nextFundingTime, intervalHours, withSeconds = true, size = 10, showCadence = true,
}: {
  nextFundingTime?: number;
  intervalHours?:   number;
  withSeconds?:     boolean;
  size?:            number;
  showCadence?:     boolean;
}) {
  const now    = useNowTick(1000);
  const target = nextFundingAt(nextFundingTime, intervalHours, now);
  if (target == null) return null;
  return (
    <span
      className="inline-flex items-center gap-1 font-mono"
      style={{ fontSize: size, color: '#0d9c6e' }}
      title="Time to this venue's next funding settlement (its real cadence)"
    >
      <span aria-hidden style={{ opacity: 0.8 }}>⏱</span>
      <span className="tabular-nums">{fmtCountdown(target - now, withSeconds)}</span>
      {showCadence && intervalHours && intervalHours > 0 && (
        <span style={{ color: '#9aa5b3' }}>· every {intervalHours}h</span>
      )}
    </span>
  );
}

// Net $/day at the user's capital, rescaled linearly from the honest per-capital
// netApy30d the engine already computed (same formula the List has always used,
// so Cards and List agree). Returns null when the field is redacted (free tier).
function netDayForCapital(s: SpreadItem, capital: number, leverage: Leverage): number | null {
  if (s.netApy30d == null) return null;
  const N0 = capital * leverage / 2;
  return (N0 * s.netApy30d / 100) / 365;
}
function feesForCapital(s: SpreadItem, capital: number, leverage: Leverage): number | null {
  if (s.totalFeesPct == null) return null;
  const N0 = capital * leverage / 2;
  return N0 * s.totalFeesPct / 100;
}
// APR run-rate on capital, capped by the honest-engine APY_CAP. Demoted metric.
// This IS simple annualization: pct === netDayForCapital × 365 / capital × 100.
function runRatePct(s: SpreadItem, leverage: Leverage): { pct: number; capped: boolean } | null {
  if (s.netApy30d == null) return null;
  const raw = leverage * s.netApy30d / 2;
  return { pct: Math.min(raw, APY_CAP), capped: raw > APY_CAP };
}

// Demoted APR label for the annualized run-rate. Simple annualization only (no
// compounding). Capped case reuses the honest-engine ceiling (APY_CAP) with the
// run-rate caveat, relabeled APR — threshold stays 200, only the wording changes.
function fmtAprLabel(rr: { pct: number; capped: boolean }): string {
  if (rr.capped) return `>${APY_CAP}% APR · run-rate, not guaranteed`;
  return `${rr.pct >= 0 ? '+' : ''}${rr.pct.toFixed(0)}% APR · run-rate`;
}

const APR_TIP =
  "APR = today's net rate × 365, simple (no compounding). A run-rate snapshot — funding changes every 8h, so this is not guaranteed.";

function fmtMoneyPlain(n: number): string {
  const abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}$${Math.round(abs).toLocaleString()}`;
  if (abs < 0.005) return `${sign}<$0.01`;
  return `${sign}$${abs.toFixed(2)}`;
}

// Tier visual system — payback-based verdict drives accent bar + label + payback.
const TIER: Record<SpreadItem['status'], { label: string; color: string; accent: string }> = {
  HARVEST:  { label: 'HARVEST',  color: '#0f766e', accent: '#0f766e' },
  CAUTION:  { label: 'CAUTION',  color: '#b45309', accent: '#b45309' },
  MARGINAL: { label: 'MARGINAL', color: '#9aa5b3', accent: '#cbd3dc' },
};

// ── Redesign: touch-friendly info tooltip ─────────────────────────────────────

function InfoTooltip({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  // Fixed (viewport-relative) placement, measured on open. This escapes the
  // card's overflow-hidden AND the right screen edge — the previous absolute
  // `left: 0` bubble overflowed the viewport on narrow screens (~360–390px).
  const [pos, setPos]   = useState<{ top: number; left: number; width: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef  = useRef<HTMLButtonElement>(null);

  const place = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r     = btn.getBoundingClientRect();
    const vw    = window.innerWidth;
    const width = Math.min(260, vw - 24);
    // Right-align to the trigger when it sits in the right half of the screen,
    // left-align otherwise; then clamp so the bubble stays ~12px inside both edges.
    const inRightHalf = r.left + r.width / 2 > vw / 2;
    let left = inRightHalf ? r.right - width : r.left;
    left = Math.max(12, Math.min(left, vw - width - 12));
    setPos({ top: r.bottom + 6, left, width });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onDoc = (e: Event) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey     = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Scroll/resize would drift a fixed bubble away from its trigger → dismiss.
    const onDismiss = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [open, place]);

  return (
    <span ref={wrapRef} className="relative inline-flex align-middle">
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center justify-center rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-mint"
        style={{ width: 36, height: 32, margin: '-8px -8px' }}
      >
        <span
          className="inline-flex items-center justify-center rounded-full font-body leading-none"
          style={{ width: 16, height: 16, fontSize: 10, border: '1px solid #e6eaef', color: '#9aa5b3' }}
        >i</span>
      </button>
      {open && pos && (
        <span
          role="tooltip"
          className="fixed z-[60] p-2.5 rounded-lg font-body leading-relaxed shadow-card"
          style={{ top: pos.top, left: pos.left, width: pos.width, maxWidth: 'min(260px, calc(100vw - 24px))', fontSize: 11, background: '#0e1626', color: '#f5f7fa' }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

// ── Redesign: signature flow strip (static SVG — no motion) ────────────────────

// Cash-flow direction of one leg from the funding-rate SIGN, not the trade side.
// Perp funding convention (as the engine applies it): rate > 0 → longs pay shorts;
// rate < 0 → shorts pay longs. The engine's net is annShort − annLong, so:
//   · SHORT leg: positive rate → you COLLECT; negative rate → you PAY.
//   · LONG  leg: negative rate → you COLLECT; positive rate → you PAY.
//   · rate exactly 0 → neither ('flat').
// This is display only — the net $/day it labels is computed elsewhere, unchanged.
type LegFlow = 'collect' | 'pay' | 'flat';
function legCashflow(side: 'short' | 'long', signedRate: number): LegFlow {
  if (signedRate === 0) return 'flat';
  const collects = side === 'short' ? signedRate > 0 : signedRate < 0;
  return collects ? 'collect' : 'pay';
}
const FLOW_COLOR: Record<LegFlow, string> = { collect: '#0f766e', pay: '#e11d48', flat: '#9aa5b3' };
const FLOW_WORD:  Record<LegFlow, string> = { collect: 'Collect', pay: 'Pay',     flat: 'Neutral' };

function FlowStrip({ s }: { s: SpreadItem }) {
  const gid        = `flow-${s.coin}-${s.shortExchange}-${s.longExchange}`;
  const shortFlow  = legCashflow('short', s.frShort);
  const longFlow   = legCashflow('long',  s.frLong);
  const shortColor = FLOW_COLOR[shortFlow];
  const longColor  = FLOW_COLOR[longFlow];
  // Real perp deep-links per leg (null → no link; never fabricated).
  const shortUrl   = venuePerpUrl(s.shortExchange, s.coin);
  const longUrl    = venuePerpUrl(s.longExchange, s.coin);

  // Arrow points toward whichever leg actually PAYS funding. In a valid spread the
  // engine shorts the higher-annualized leg, so at most one leg can pay; if neither
  // pays, both legs collect → no directional arrow (nothing is being paid out).
  const paySide: 'short' | 'long' | null =
    shortFlow === 'pay' ? 'short' : longFlow === 'pay' ? 'long' : null;
  const bothCollect = shortFlow === 'collect' && longFlow === 'collect';
  const caption     = bothCollect ? 'both collect' : 'net spread';

  return (
    <div
      className="rounded-[10px] px-3 py-2.5 flex items-stretch gap-2"
      style={{ background: '#fbfcfd', border: '1px solid #eef2f6' }}
    >
      {/* SHORT leg — word + color driven by rate sign, not the side */}
      <div className="flex flex-col justify-center min-w-0 shrink">
        <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: '0.12em', color: shortColor }}>
          Short · {FLOW_WORD[shortFlow]}
        </span>
        <span className="inline-flex items-center gap-1 mt-1 min-w-0">
          <PlatformLogo platform={s.shortExchange} size={12} />
          <span className="font-mono font-bold text-ink truncate" style={{ fontSize: 12 }}>{venueLabel(s.shortExchange)}</span>
          {shortUrl && <PlatformLink href={shortUrl} label={venueLabel(s.shortExchange)} compact className="shrink-0" />}
        </span>
        <span className="font-mono tabular-nums mt-0.5" style={{ fontSize: 11, color: shortColor }}>
          {fmtRate8h(s.frShort, s.intervalHoursShort)}<span style={{ color: '#9aa5b3' }}> /8h</span>
        </span>
        <span className="mt-0.5">
          <LegFundingCountdown nextFundingTime={s.nextFundingTimeShort} intervalHours={s.intervalHoursShort} />
        </span>
      </div>

      {/* Connector — gradient runs SHORT-color → LONG-color; arrow toward pay side */}
      <div className="flex-1 flex flex-col items-center justify-center" style={{ minWidth: 52 }}>
        <svg viewBox="0 0 100 16" preserveAspectRatio="none" className="w-full" height="16" aria-hidden>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={shortColor} />
              <stop offset="100%" stopColor={longColor} />
            </linearGradient>
          </defs>
          <line x1="4" y1="8" x2="88" y2="8" stroke={`url(#${gid})`} strokeWidth="1.5" />
          <circle cx="46" cy="8" r="2.4" fill="#0e1626" />
          {paySide === 'long'  && <path d="M88 8 L82 5 L82 11 Z" fill={longColor} />}
          {paySide === 'short' && <path d="M4 8 L10 5 L10 11 Z"  fill={shortColor} />}
        </svg>
        <span className="font-body uppercase mt-1" style={{ fontSize: 7.5, letterSpacing: '0.14em', color: '#9aa5b3' }}>
          {caption}
        </span>
      </div>

      {/* LONG leg — word + color driven by rate sign, not the side */}
      <div className="flex flex-col justify-center items-end text-right min-w-0 shrink">
        <span className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: '0.12em', color: longColor }}>
          Long · {FLOW_WORD[longFlow]}
        </span>
        <span className="inline-flex flex-row-reverse items-center gap-1 mt-1 min-w-0">
          <PlatformLogo platform={s.longExchange} size={12} />
          <span className="font-mono font-bold text-ink truncate" style={{ fontSize: 12 }}>{venueLabel(s.longExchange)}</span>
          {longUrl && <PlatformLink href={longUrl} label={venueLabel(s.longExchange)} compact className="shrink-0" />}
        </span>
        <span className="font-mono tabular-nums mt-0.5" style={{ fontSize: 11, color: longColor }}>
          {fmtRate8h(s.frLong, s.intervalHoursLong)}<span style={{ color: '#9aa5b3' }}> /8h</span>
        </span>
        <span className="mt-0.5">
          <LegFundingCountdown nextFundingTime={s.nextFundingTimeLong} intervalHours={s.intervalHoursLong} />
        </span>
      </div>
    </div>
  );
}

// ── Redesign: plain-language capacity row ─────────────────────────────────────

const CAPACITY_TIP =
  'The largest amount you can put in before slippage eats the yield. ' +
  'Measured from the live order book — never a guess.' +
  ' Above $500k the book is deeper than we measure — shown as $500k+.';

const TOO_THIN_TIP =
  'The order book was measured, but right now it is too thin to absorb a meaningful position — ' +
  'slippage would eat the funding at every size, so there is no safe amount to enter.';

function CapacityRow({
  s, capital, leverage, redacted,
}: { s: SpreadItem; capital: number; leverage: Leverage; redacted: boolean }) {
  const gc = s.greenCapacityUsd;
  const N0 = capital * leverage / 2;
  const kase = redacted ? 'C' : capCase(s);
  const hasCap = !redacted && kase === 'A';
  const measuredTooThin = !redacted && kase === 'B';
  // Headroom = how much of the order-book green capacity your current position
  // leaves unused. Falls as capital approaches the depth limit → bar reddens.
  const headroom = hasCap ? Math.max(0, Math.min(100, (1 - N0 / (gc as number)) * 100)) : 0;
  const barColor = headroom >= 60 ? '#14b8a6' : headroom >= 30 ? '#b45309' : '#e11d48';

  return (
    <div className="pt-2.5 mt-1" style={{ borderTop: '1px solid #eef2f6' }}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 font-body" style={{ fontSize: 11, color: '#6b7787' }}>
          Max before slippage
          <InfoTooltip label="Max before slippage — how it's measured" text={CAPACITY_TIP} />
        </span>
        {redacted ? (
          <Redacted value={s.greenCapacityUsd}>
            {v => <span className="font-mono tabular-nums text-ink" style={{ fontSize: 12 }}>{fmtCapDisplay(v)}</span>}
          </Redacted>
        ) : hasCap ? (
          <span className="font-mono tabular-nums text-ink" style={{ fontSize: 12 }}>{fmtCapDisplay(gc as number)}</span>
        ) : measuredTooThin ? (
          <span className="inline-flex items-center gap-1 font-body" style={{ fontSize: 11, color: '#b45309' }}>
            too thin to size
            <InfoTooltip label="Too thin to size — what it means" text={TOO_THIN_TIP} />
          </span>
        ) : (
          <span className="font-body" style={{ fontSize: 11, color: '#9aa5b3' }}>not available yet</span>
        )}
      </div>
      {hasCap && (
        <>
          <div className="mt-1.5 w-full rounded-full overflow-hidden" style={{ height: 5, background: '#eef2f6' }}>
            <div style={{ width: `${headroom}%`, height: '100%', background: barColor, borderRadius: 999 }} />
          </div>
          <p className="mt-1.5 font-body leading-snug" style={{ fontSize: 10.5, color: '#9aa5b3' }}>
            Put in more than this and your entry price gets worse — the extra cost starts eating your profit.
          </p>
        </>
      )}
      {measuredTooThin && (
        <p className="mt-1.5 font-body leading-snug" style={{ fontSize: 10.5, color: '#9aa5b3' }}>
          Order book too shallow right now — no size clears without heavy slippage.
        </p>
      )}
    </div>
  );
}

// ── Redesign: opportunity card ────────────────────────────────────────────────

function FundingCard({ s, capital, leverage }: { s: SpreadItem; capital: number; leverage: Leverage }) {
  const tier       = TIER[s.status];
  const redacted   = s.netApy30d == null;
  const netDay     = netDayForCapital(s, capital, leverage);
  const fees       = feesForCapital(s, capital, leverage);
  const rr         = runRatePct(s, leverage);
  const detailHref = `/dashboard/funding-arb/${s.coin}-${s.shortExchange}-${s.longExchange}`;

  return (
    <div
      className="relative rounded-card bg-surface overflow-hidden flex flex-col gap-3 p-4"
      style={{ paddingLeft: 18, border: '1px solid #e6eaef', boxShadow: '0 1px 2px rgba(14,22,38,.05)' }}
    >
      <span aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: tier.accent }} />

      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center flex-wrap gap-x-2 gap-y-1 min-w-0">
          <span className="font-mono font-bold text-ink tracking-tight truncate" style={{ fontSize: 15 }}>{s.coin}</span>
          <span className="font-body uppercase" style={{ fontSize: 9, letterSpacing: '0.14em', color: tier.color }}>{tier.label}</span>
        </div>
        <div className="text-right shrink-0">
          <div className="font-body uppercase" style={{ fontSize: 8.5, letterSpacing: '0.12em', color: '#9aa5b3' }}>payback</div>
          <div className="font-mono font-semibold tabular-nums" style={{ fontSize: 13, color: tier.color }}>
            <Redacted value={s.breakevenDays}>{v => formatPayback(v)}</Redacted>
          </div>
        </div>
      </div>

      <FlowStrip s={s} />

      {/* Net row */}
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          {redacted ? (
            <div className="font-mono font-bold" style={{ fontSize: 22 }}>
              <Redacted value={s.netApy30d}>{() => null}</Redacted>
            </div>
          ) : netDay != null ? (
            <div
              className={`font-mono font-bold tabular-nums leading-none ${s.oneLegUnverified ? 'text-muted' : 'text-ink'}`}
              style={{ fontSize: 24 }}
            >
              {fmtMoneyPlain(netDay)}
            </div>
          ) : (
            <div className="font-mono font-bold text-muted" style={{ fontSize: 24 }}>—</div>
          )}
          <div className="font-body mt-1" style={{ fontSize: 10, color: '#6b7787' }}>
            net / day
          </div>
        </div>
        <div className="text-right font-mono tabular-nums shrink-0" style={{ fontSize: 10, color: '#9aa5b3' }}>
          {redacted ? (
            <Redacted value={s.totalFeesPct}>{() => null}</Redacted>
          ) : (
            <>
              {fees != null && <div>fees {fmtMoneyPlain(fees)}</div>}
              {rr && (
                <div className="inline-flex items-center justify-end gap-0.5">
                  <span>{fmtAprLabel(rr)}</span>
                  <InfoTooltip label="APR — how it's calculated" text={APR_TIP} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <CapacityRow s={s} capital={capital} leverage={leverage} redacted={redacted} />

      {/* Footer */}
      <div className="flex items-center justify-end pt-0.5">
        <Link
          href={detailHref}
          className="font-body rounded-button transition-colors duration-100 hover:text-ink-2"
          style={{ fontSize: 11, padding: '8px 12px', border: '1px solid #e6eaef', color: '#6b7787' }}
        >
          Execution guide →
        </Link>
      </div>
    </div>
  );
}

// ── Redesign: opportunity list (same semantics as the cards) ──────────────────

function FundingList({ items, capital, leverage }: { items: SpreadItem[]; capital: number; leverage: Leverage }) {
  return (
    <div className="rounded-card overflow-hidden bg-surface" style={{ border: '1px solid #e6eaef' }}>
      {items.map((s, i) => {
        const tier       = TIER[s.status];
        const redacted   = s.netApy30d == null;
        const netDay     = netDayForCapital(s, capital, leverage);
        const rr         = runRatePct(s, leverage);
        const detailHref = `/dashboard/funding-arb/${s.coin}-${s.shortExchange}-${s.longExchange}`;
        return (
          <div
            key={`${s.coin}-${s.shortExchange}-${s.longExchange}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5"
            style={{ borderTop: i ? '1px solid #eef2f6' : 'none', borderLeft: `3px solid ${tier.accent}` }}
          >
            <span className="font-mono font-bold text-ink tracking-tight shrink-0" style={{ fontSize: 13, width: 52 }}>{s.coin}</span>

            {/* Flow, normalized to %/8h — each leg carries its own next-funding clock */}
            <span className="font-mono tabular-nums inline-flex items-center gap-1.5 min-w-0 flex-wrap" style={{ fontSize: 11 }}>
              <span style={{ color: '#0f766e' }}>{venueLabel(s.shortExchange)} {fmtRate8h(s.frShort, s.intervalHoursShort)}</span>
              <LegFundingCountdown nextFundingTime={s.nextFundingTimeShort} intervalHours={s.intervalHoursShort} size={9.5} showCadence={false} />
              <span style={{ color: '#9aa5b3' }}>→</span>
              <span style={{ color: '#e11d48' }}>{venueLabel(s.longExchange)} {fmtRate8h(s.frLong, s.intervalHoursLong)}</span>
              <LegFundingCountdown nextFundingTime={s.nextFundingTimeLong} intervalHours={s.intervalHoursLong} size={9.5} showCadence={false} />
              <span style={{ color: '#9aa5b3' }}>/8h</span>
            </span>

            {/* Net / day */}
            <span className="ml-auto font-mono tabular-nums font-bold" style={{ fontSize: 13 }}>
              {redacted ? (
                <Redacted value={s.netApy30d}>{() => null}</Redacted>
              ) : netDay != null ? (
                <span className={s.oneLegUnverified ? 'text-muted' : 'text-ink'}>{fmtMoneyPlain(netDay)}</span>
              ) : (
                <span className="text-muted">—</span>
              )}
              <span className="font-body font-normal ml-1" style={{ fontSize: 10, color: '#9aa5b3' }}>/day</span>
            </span>

            {/* APR run-rate — demoted */}
            <span className="font-mono tabular-nums inline-flex items-center gap-0.5" style={{ fontSize: 10, color: '#9aa5b3' }}>
              {redacted ? (
                <Redacted value={s.netApy30d}>{() => null}</Redacted>
              ) : rr ? (
                <>
                  <span>{fmtAprLabel(rr)}</span>
                  <InfoTooltip label="APR — how it's calculated" text={APR_TIP} />
                </>
              ) : '—'}
            </span>

            {/* Payback */}
            <span className="font-mono font-semibold tabular-nums" style={{ fontSize: 11, color: tier.color }}>
              <Redacted value={s.breakevenDays}>{v => formatPayback(v)}</Redacted>
            </span>

            {/* Max before slippage — same three cases as the card */}
            <span className="font-mono tabular-nums" style={{ fontSize: 10, color: '#6b7787' }}>
              {redacted ? (
                <Redacted value={s.greenCapacityUsd}>{v => fmtCapDisplay(v)}</Redacted>
              ) : capCase(s) === 'A' ? (
                fmtCapDisplay(s.greenCapacityUsd as number)
              ) : capCase(s) === 'B' ? (
                <span style={{ color: '#b45309' }}>too thin</span>
              ) : (
                <span style={{ color: '#9aa5b3' }}>n/a</span>
              )}
            </span>

            <Link
              href={detailHref}
              aria-label={`Execution guide for ${s.coin}`}
              className="font-body rounded-button hover:text-ink-2 transition-colors duration-100"
              style={{ fontSize: 12, padding: '6px 8px', color: '#9aa5b3' }}
            >
              →
            </Link>
          </div>
        );
      })}
    </div>
  );
}

// ── Opportunity cards / list ──────────────────────────────────────────────────

const CARDS_DEFAULT = 6;

const EXCHANGES_STORAGE_KEY = 'edgeradar.funding.exchanges';

type OppView = 'cards' | 'list';

// Display-only exchange filter: persists the selected venue set to localStorage.
// `null` = never customized → treat every venue as selected (also the fallback
// when storage is absent or malformed). Once the user toggles a chip we store an
// explicit set. This is a view filter only — no funding/payback math is touched.
function useExchangeFilter(venues: string[]) {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(EXCHANGES_STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.every(x => typeof x === 'string')) {
          setSelected(new Set(arr));
        }
      }
    } catch { /* fall back to all-selected */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || selected === null) return;
    try {
      localStorage.setItem(EXCHANGES_STORAGE_KEY, JSON.stringify(Array.from(selected)));
    } catch { /* storage failure must never break the page */ }
  }, [selected, hydrated]);

  const isSelected = (v: string) => (selected === null ? true : selected.has(v));
  const allOn      = venues.length > 0 && venues.every(isSelected);

  const toggle = (v: string) =>
    setSelected(prev => {
      const base = prev === null ? new Set(venues) : new Set(prev);
      if (base.has(v)) base.delete(v); else base.add(v);
      return base;
    });
  const selectAll = () => setSelected(new Set(venues));
  const clearAll  = () => setSelected(new Set());

  return { isSelected, allOn, toggle, selectAll, clearAll };
}

function ExchangeFilterBar({
  venues, isSelected, toggle, selectAll, clearAll, selectedCount,
}: {
  venues:        string[];
  isSelected:    (v: string) => boolean;
  toggle:        (v: string) => void;
  selectAll:     () => void;
  clearAll:      () => void;
  selectedCount: number;
}) {
  return (
    <div className="rounded-card bg-surface p-3" style={{ border: '1px solid #e6eaef', boxShadow: '0 1px 2px rgba(14,22,38,.05)' }}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="font-body uppercase" style={{ fontSize: 10, letterSpacing: '0.12em', color: '#6b7787' }}>
          Exchanges you can trade
          <span className="ml-2 font-mono tabular-nums" style={{ color: '#9aa5b3' }}>{selectedCount}/{venues.length}</span>
        </span>
        <div className="flex items-center gap-2 shrink-0 font-body" style={{ fontSize: 11 }}>
          <button onClick={selectAll} style={{ color: '#0f766e' }} className="hover:opacity-80">Select all</button>
          <span style={{ color: '#e6eaef' }}>·</span>
          <button onClick={clearAll} style={{ color: '#9aa5b3' }} className="hover:opacity-80">Clear all</button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {venues.map(v => {
          const on = isSelected(v);
          return (
            <button
              key={v}
              onClick={() => toggle(v)}
              aria-pressed={on}
              className="inline-flex items-center gap-1 font-body rounded-pill transition-colors duration-100"
              style={{
                fontSize: 11, minHeight: 36, padding: '0 10px',
                ...(on
                  ? { border: '1px solid #0f766e', background: '#effcf9', color: '#0f766e' }
                  : { border: '1px solid #e6eaef', background: '#ffffff', color: '#9aa5b3' }),
              }}
            >
              {on && <span aria-hidden>✓</span>}
              <PlatformLogo platform={v} size={12} />
              {venueLabel(v)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OpportunityCards({
  spreads, capital, leverage,
}: {
  spreads:  SpreadItem[];
  capital:  number;
  leverage: Leverage;
}) {
  const [showMore, setShowMore] = useState(false);
  const [view,     setView]     = useState<OppView>('cards');

  // Venue universe derived dynamically from the current data so new exchanges
  // appear automatically. Stable within a data snapshot.
  const venues = useMemo(
    () => Array.from(new Set(spreads.flatMap(s => [s.shortExchange, s.longExchange]))).sort(),
    [spreads],
  );
  const filter = useExchangeFilter(venues);

  // A pair needs accounts on BOTH venues to execute → visible only if both legs
  // are in the selected set.
  const exFiltered = spreads.filter(
    s => filter.isSelected(s.shortExchange) && filter.isSelected(s.longExchange),
  );

  // Sort by fastest payback ascending (primary — never broken across tiers).
  // Within EQUAL payback, break ties by capacity so scalable pairs rise above
  // unscalable ones: capacityRank (real cap > measured-thin > unmeasured), then
  // deeper green capacity first, then verdict tier, then net $/day descending.
  // A faster-payback thin pair still outranks a slower-payback deep pair.
  // Redacted payback sinks last; redacted capacity is uniform so it's a no-op.
  const statusRank = { HARVEST: 0, CAUTION: 1, MARGINAL: 2 } as const;
  const sorted = [...exFiltered].sort((a, b) => {
    const pa = a.breakevenDays ?? Infinity, pb = b.breakevenDays ?? Infinity;
    if (pa !== pb) return pa - pb;
    const ra = capRank(a), rb = capRank(b);
    if (ra !== rb) return rb - ra;
    if (ra === 2) {
      const ga = a.greenCapacityUsd ?? 0, gb = b.greenCapacityUsd ?? 0;
      if (ga !== gb) return gb - ga;
    }
    if (statusRank[a.status] !== statusRank[b.status]) return statusRank[a.status] - statusRank[b.status];
    const na = netDayForCapital(a, capital, leverage) ?? -Infinity;
    const nb = netDayForCapital(b, capital, leverage) ?? -Infinity;
    return nb - na;
  });

  // Best pair per unique coin (post-sort → best-payback pair per coin)
  const seenCoins = new Set<string>();
  const allItems: SpreadItem[] = [];
  for (const s of sorted) {
    if (!seenCoins.has(s.coin)) { seenCoins.add(s.coin); allItems.push(s); }
  }

  if (spreads.length === 0) return null;

  const visible       = showMore ? allItems : allItems.slice(0, CARDS_DEFAULT);
  const remaining     = allItems.length - CARDS_DEFAULT;
  const selectedCount = venues.filter(filter.isSelected).length;

  return (
    <div className="mb-6">
      <ExchangeFilterBar
        venues={venues}
        isSelected={filter.isSelected}
        toggle={filter.toggle}
        selectAll={filter.selectAll}
        clearAll={filter.clearAll}
        selectedCount={selectedCount}
      />

      {/* List header */}
      <div className="flex items-center justify-between gap-2 mt-5 mb-2">
        <div className="min-w-0">
          <span className="font-body font-medium text-ink" style={{ fontSize: 12 }}>Top opportunities</span>
          <span className="ml-1.5 font-mono tabular-nums" style={{ fontSize: 12, color: '#9aa5b3' }}>· {allItems.length}</span>
          <span className="ml-2 font-body" style={{ fontSize: 11, color: '#9aa5b3' }}>fastest payback first</span>
        </div>
        <div className="flex rounded-button overflow-hidden shrink-0" style={{ border: '1px solid #e6eaef' }}>
          {(['cards', 'list'] as OppView[]).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className="px-3 py-1 font-body capitalize transition-colors duration-100"
              style={view === v ? { fontSize: 11, background: '#0f766e', color: '#fff' } : { fontSize: 11, color: '#6b7787' }}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3 font-body" style={{ fontSize: 10 }}>
        <span><span className="font-semibold" style={{ color: '#0f766e' }}>HARVEST</span> <span style={{ color: '#9aa5b3' }}>≤5d</span></span>
        <span style={{ color: '#e6eaef' }}>·</span>
        <span><span className="font-semibold" style={{ color: '#b45309' }}>CAUTION</span> <span style={{ color: '#9aa5b3' }}>5–10d</span></span>
        <span style={{ color: '#e6eaef' }}>·</span>
        <span><span className="font-semibold" style={{ color: '#9aa5b3' }}>MARGINAL</span> <span style={{ color: '#9aa5b3' }}>&gt;10d</span></span>
        <span className="ml-auto font-mono" style={{ color: '#9aa5b3' }}>rates /8h</span>
      </div>

      {allItems.length === 0 && (
        <div className="py-12 text-center">
          <p className="font-body text-ink-2" style={{ fontSize: 13 }}>No pairs on your selected exchanges.</p>
          <p className="font-body mt-1" style={{ fontSize: 11, color: '#9aa5b3' }}>Add one back above.</p>
        </div>
      )}

      {allItems.length > 0 && view === 'cards' && (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map(s => (
            <FundingCard key={`${s.coin}-${s.shortExchange}-${s.longExchange}`} s={s} capital={capital} leverage={leverage} />
          ))}
        </div>
      )}

      {allItems.length > 0 && view === 'list' && (
        <FundingList items={visible} capital={capital} leverage={leverage} />
      )}

      {remaining > 0 && (
        <button
          onClick={() => setShowMore(v => !v)}
          className="mt-4 font-body hover:opacity-80 transition-opacity duration-100"
          style={{ fontSize: 12, color: '#0f766e' }}
        >
          {showMore ? 'Show fewer ↑' : `Show ${remaining} more ↓`}
        </button>
      )}
    </div>
  );
}

// ── Status legend (advanced only) ─────────────────────────────────────────────

function StatusLegend() {
  return (
    <div className="px-4 py-2 bg-bg-soft/20 border-b border-line/30 flex flex-wrap gap-x-5 gap-y-0.5 items-center">
      <span className="font-body text-[9px]">
        <span className="text-mint-deep font-semibold">HARVEST</span>
        <span className="text-muted"> = fees back in ≤5 days</span>
      </span>
      <span className="font-body text-[9px]">
        <span className="text-gold font-semibold">CAUTION</span>
        <span className="text-muted"> = 5–10 days</span>
      </span>
      <span className="font-body text-[9px]">
        <span className="text-coral-ink/70 font-semibold">MARGINAL</span>
        <span className="text-muted"> = {'>'}10 days — spread likely shifts first</span>
      </span>
      <span className="font-body text-[9px] ml-auto hidden sm:inline">
        <span className="text-mint">DEEP</span>
        <span className="text-muted"> &gt;$50M · </span>
        <span className="text-ink-2">OK</span>
        <span className="text-muted"> &gt;$10M · </span>
        <span className="text-gold">THIN</span>
        <span className="text-muted"> &gt;$1M</span>
      </span>
    </div>
  );
}

// ── Table helpers ─────────────────────────────────────────────────────────────

function LiqChip({ tier, thin }: { tier: string | null; thin: boolean }) {
  if (!tier) return <span className="font-body text-[9px] text-muted">—</span>;
  const cls: Record<string, string> = {
    DEEP:        'border-mint/40 text-mint',
    OK:          'border-line text-ink-2',
    THIN:        'border-gold/50 text-gold',
    'VERY THIN': 'border-coral-ink/40 text-coral-ink/80',
  };
  return (
    <span className={`px-1 py-[1px] border text-[8px] font-body uppercase ${cls[tier] ?? 'border-line text-muted'}`}>
      {tier}{thin ? ' ⚠' : ''}
    </span>
  );
}

function FeeNote({ meta }: { meta: Meta | null }) {
  if (!meta) return null;
  return (
    <p className="font-body text-[9px] text-muted mt-1.5 leading-relaxed">
      Fee/leg: Binance/Bybit/OKX {meta.feePerLeg.cex}% · Gate.io 0.05% · Bitget 0.06% · Hyperliquid {meta.feePerLeg.dex}% · dYdX 0.05% · Aster 0.04% · Paradex 0.02% · edgeX 0.038% · Grvt 0.045% · Lighter 0% · Extended 0.025% · Pacifica 0.04% · ApeX 0.05%.
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
    cls:   'text-mint-deep',
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
        <div className="py-8 text-center font-body text-[10px] text-muted">No pairs in current data.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[11px] border-collapse">
            <thead>
              <tr className="border-b border-line">
                {TABLE_HEADERS.map(h => (
                  <th
                    key={h.label}
                    title={h.tip}
                    className={`px-3 py-2 text-left text-[9px] uppercase tracking-widest font-normal whitespace-nowrap ${h.cls ?? 'text-muted'} ${h.tip ? 'cursor-help' : ''}`}
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
                    <tr className={`border-b ${sz ? 'border-line/20' : 'border-line/50'} hover:bg-bg-soft/40 transition-colors duration-100 ${isMarginal ? 'opacity-50' : ''} ${s.thinFlag ? 'opacity-70' : ''}`}>
                      <td className="px-3 py-2.5 font-semibold text-ink">{s.coin}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 ${s.shortIsDex ? 'text-mint' : 'text-ink-2'}`}><PlatformLogo platform={s.shortExchange} size={11} />{venueLabel(s.shortExchange)}</span>
                        <span className="text-line mx-1">·</span>
                        <span className={rateCls(s.frShort)}>{fmtRate(s.frShort, s.intervalHoursShort)}</span>
                        <span className="ml-1.5"><LegFundingCountdown nextFundingTime={s.nextFundingTimeShort} intervalHours={s.intervalHoursShort} withSeconds={false} size={9} showCadence={false} /></span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1 ${s.longIsDex ? 'text-mint' : 'text-ink-2'}`}><PlatformLogo platform={s.longExchange} size={11} />{venueLabel(s.longExchange)}</span>
                        <span className="text-line mx-1">·</span>
                        <span className={rateCls(s.frLong)}>{fmtRate(s.frLong, s.intervalHoursLong)}</span>
                        <span className="ml-1.5"><LegFundingCountdown nextFundingTime={s.nextFundingTimeLong} intervalHours={s.intervalHoursLong} withSeconds={false} size={9} showCadence={false} /></span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {sz ? (
                          <div className="flex flex-col gap-0.5">
                            <span className={`text-base font-bold ${s.oneLegUnverified ? 'text-muted' : sz.roc > 0 ? 'text-mint-deep' : 'text-coral-ink/70'}`}>
                              {fmtDayUsd(sz.dayUsd)}
                            </span>
                            <span className="font-mono text-[9px] text-muted/60">
                              {fmtApy(sz.roc)} ROC · run-rate · excl. entry slippage
                            </span>
                          </div>
                        ) : (
                          <span className={`text-base font-bold ${(s.netApy30d ?? 0) > 0 ? 'text-mint-deep' : 'text-coral-ink/70'}`}>
                            <Redacted value={s.netApy30d}>{v => fmtApy(v)}</Redacted>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-[10px] text-muted">
                        <Redacted value={s.grossApy}>{v => fmtApy(v)}</Redacted>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-muted text-[10px] whitespace-nowrap">
                        <Redacted value={s.totalFeesPct}>{v => `${v.toFixed(2)}%`}</Redacted>
                        {s.hasDexLeg && <span className="text-mint ml-1">†</span>}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-ink-2 whitespace-nowrap">
                        <Redacted value={s.breakevenDays}>{v => `${v}d`}</Redacted>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`px-1.5 py-[2px] border text-[9px] uppercase tracking-widest font-body ${statusBadgeCls(s.status)}`}>
                          {s.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <div className="flex flex-col gap-0.5">
                          <LiqChip tier={s.liquidityTier} thin={s.thinFlag} />
                          {s.greenCapacityUsd != null && (
                            <span className={`font-mono text-[8px] ${s.greenCapacityUsd === 0 ? 'text-gold/70' : 'text-mint-deep/70'}`}>
                              {s.greenCapacityUsd === 0 ? '$0 green' : fmtCapWords(s.greenCapacityUsd)}
                            </span>
                          )}
                          {s.depthThin && s.depthNote && (
                            <span className="font-mono text-[8px] text-gold/70 leading-tight">{s.depthNote}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {sz && (
                      <tr className="border-b border-line/50 bg-bg-soft/10">
                        <td colSpan={9} className="px-3 py-1.5">
                          <div className="flex flex-wrap gap-x-4 font-mono text-[10px]">
                            {s.oneLegUnverified && (
                              <span className="text-muted/70 italic">1 leg unverified — spread uses predicted rate, may be overstated.</span>
                            )}
                            <span className="text-muted">N/leg <span className="text-ink tabular-nums">{fmtUsd(sz.N)}</span></span>
                            <span className="text-muted">Fees <span className="text-ink tabular-nums">{fmtUsd(sz.feesUsd)}</span></span>
                            <span className="text-muted">Net 30d <span className={`tabular-nums ${sz.net30dUsd >= 0 ? 'text-mint-deep' : 'text-coral-ink'}`}>{fmtUsd(sz.net30dUsd)}</span></span>
                            {/* Annualized $/yr — demoted run-rate; above APY_CAP the $/yr is an
                                over-projection, so show the capped ceiling, never a raw inflated $. */}
                            <span className="text-muted">Net/yr* <span className={`tabular-nums ${sz.netYrUsd >= 0 ? 'text-mint-deep' : 'text-coral-ink'}`}>{isOverApyCap(sz.roc) ? `>${APY_CAP}%/yr` : fmtUsd(sz.netYrUsd)}</span></span>
                            <span className="ml-auto text-muted">ROC* <span className={`tabular-nums font-semibold ${sz.roc >= 0 ? 'text-mint-deep' : 'text-coral-ink'}`}>{fmtApy(sz.roc)}</span></span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <div className="px-3 pt-1.5 font-body text-[9px] text-muted/70">
            * Annualized figures (ROC %/yr, Net/yr) are run-rate, not guaranteed — annualized from current funding, which changes every 1h/8h; caps at &gt;{APY_CAP}%/yr.
          </div>
          {spreads.some(s => s.hasDexLeg) && (
            <div className="px-3 pb-2 pt-1 font-body text-[9px] text-mint/70 space-y-0.5">
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
  const DEX_ORDER    = ['hyperliquid', 'dydx', 'aster', 'paradex', 'edgex', 'grvt', 'lighter', 'extended', 'pacifica', 'apex'];
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
          <tr className="border-b border-line">
            <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-muted font-normal">Asset</th>
            {allExchanges.map(ex => (
              <th key={ex} className={`px-3 py-2 text-left text-[9px] uppercase tracking-widest font-normal whitespace-nowrap ${DEX_ORDER.includes(ex) ? 'text-mint' : 'text-muted'}`}>
                <span className="inline-flex items-center gap-1">
                  <PlatformLogo platform={ex} size={10} />
                  {ex === 'dydx' ? 'dYdX (DEX)' : ex === 'hyperliquid' ? 'Hyperliquid (DEX)' : capFirst(ex)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {coins.map(coin => (
            <tr key={coin} className="border-b border-line/50 hover:bg-bg-soft/40 transition-colors duration-100">
              <td className="px-3 py-2.5 font-semibold text-ink">{coin}</td>
              {allExchanges.map(ex => {
                const data = futures[ex]?.[coin];
                if (!data) return <td key={ex} className="px-3 py-2.5 text-muted/30 text-[10px]">—</td>;
                const intervalH = data.fundingIntervalHours ?? 8;
                return (
                  <td key={ex} className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                    <span className={rateCls(data.fundingRate)}>{fmtRate(data.fundingRate, intervalH)}</span>
                    {data.markPrice != null && (
                      <span className="ml-2 text-muted text-[9px]">
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
      <div className="px-4 py-2 border-b border-line flex items-center justify-between flex-wrap gap-2">
        <span className="font-body text-[10px] uppercase tracking-widest text-muted">CEX Spot Arbitrage</span>
        <span className="font-body text-[9px] text-muted">
          {items.length > 0
            ? `${items.length} spread${items.length > 1 ? 's' : ''} above 0.3% threshold`
            : 'spot price spread · threshold 0.3%'}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="px-4 py-6 text-center space-y-1">
          <div className="font-body text-[11px] text-muted">No spot spread above threshold right now</div>
          <div className="font-body text-[9px] text-muted/50">
            Scanner checks Binance · Bybit · OKX every 60s · threshold 0.3% · execution risk: slippage + withdrawal lag
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[11px] border-collapse">
            <thead>
              <tr className="border-b border-line">
                {['Asset', 'Buy on (low)', 'Buy price', 'Sell on (high)', 'Sell price', 'Spread'].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-[9px] uppercase tracking-widest font-normal text-muted whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map(a => (
                <tr key={`${a.coin}-${a.low}-${a.high}`} className="border-b border-line/50 hover:bg-bg-soft/40 transition-colors duration-100">
                  <td className="px-3 py-2.5 font-semibold text-ink">{a.coin}</td>
                  <td className="px-3 py-2.5 text-ink-2 capitalize">
                    <span className="inline-flex items-center gap-1"><PlatformLogo platform={a.low} size={11} />{a.low}</span>
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-ink">
                    ${a.lowPrice.toLocaleString(undefined, { maximumFractionDigits: a.lowPrice > 1 ? 2 : 5 })}
                  </td>
                  <td className="px-3 py-2.5 text-ink-2 capitalize">
                    <span className="inline-flex items-center gap-1"><PlatformLogo platform={a.high} size={11} />{a.high}</span>
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-ink">
                    ${a.highPrice.toLocaleString(undefined, { maximumFractionDigits: a.highPrice > 1 ? 2 : 5 })}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums font-bold text-mint-deep">+{a.spreadPct.toFixed(3)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 font-body text-[9px] text-muted/60">
            Spread is gross · subtract withdrawal fee + transfer time · signals only, no execution.
          </p>
        </div>
      )}
    </div>
  );
}

// ── RWA · Commodities (beta) — OBSERVATION strip ──────────────────────────────
// Gold/silver/oil across Aster + Extended. Shows each leg's real funding (%/8h) and
// real order-book depth, but DELIBERATELY renders no cashable net/day: RWA funding is
// flat/near-zero on these oracle-tracking perps, so no honest cashable spread exists yet.
function fmtRwaDepth(n: number | null): string {
  if (n == null || n <= 0) return '—';
  return n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;
}

function RwaCommoditiesStrip({ rows }: { rows: RwaObservation[] }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div className="mb-5 rounded-card border bg-surface" style={{ borderColor: '#e6eaef', boxShadow: '0 1px 2px rgba(14,22,38,.05)' }}>
      <div className="px-4 py-2.5 flex items-center gap-2 border-b" style={{ borderColor: '#eef2f6' }}>
        <span className="font-body uppercase tracking-wide" style={{ fontSize: 11, color: '#6b7787' }}>RWA · Commodities</span>
        <span className="px-1.5 py-[1px] rounded-pill font-body uppercase" style={{ fontSize: 8.5, letterSpacing: '0.1em', background: '#eef6f2', color: '#0f766e' }}>beta</span>
        <span className="ml-auto font-body" style={{ fontSize: 9.5, color: '#9aa5b3' }}>observing funding · not cashable yet</span>
      </div>
      <div>
        {rows.map((r, i) => (
          <div
            key={r.underlying}
            className="px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1"
            style={{ borderTop: i ? '1px solid #f1f4f7' : 'none' }}
          >
            <span className="font-mono font-bold text-ink shrink-0" style={{ fontSize: 12, width: 96 }}>{r.label}</span>
            <span className="font-mono tabular-nums inline-flex items-center gap-x-3 gap-y-0.5 flex-wrap min-w-0" style={{ fontSize: 11 }}>
              {r.legs.map(l => (
                <span key={l.venue} style={{ color: '#6b7787' }}>
                  {l.platform}{' '}
                  <span className="tabular-nums" style={{ color: l.rate8h >= 0 ? '#0d9c6e' : '#e11d48' }}>
                    {l.rate8h >= 0 ? '+' : ''}{l.rate8h.toFixed(4)}%
                  </span>
                </span>
              ))}
              <span style={{ color: '#9aa5b3' }}>/8h</span>
            </span>
            <span className="ml-auto font-mono tabular-nums shrink-0" style={{ fontSize: 10.5, color: '#6b7787' }}>
              book depth <span className="text-ink">{fmtRwaDepth(r.bookDepthUsd)}</span>
            </span>
            <span
              className="px-1.5 py-[2px] border font-body uppercase tracking-widest shrink-0"
              style={{ fontSize: 8.5, borderColor: '#e6eaef', color: '#9aa5b3' }}
              title="beta · observing funding, not cashable yet"
            >
              Signal · observe
            </span>
          </div>
        ))}
      </div>
      <div className="px-4 pb-2 pt-1 font-body" style={{ fontSize: 9, color: '#9aa5b3' }}>
        Gold / silver / oil on Aster + Extended · real order-book depth. Funding on these oracle-tracking
        perps is flat/near-zero, so there is no cashable net/day yet — this strip is observation only.
      </div>
    </div>
  );
}

// ── Perp vs Spot (delta-neutral carry) ────────────────────────────────────────
// Hold spot, short the perp on the venue paying the most funding → collect the FULL
// absolute funding rate (not a perp/perp spread). All $ figures on a row's `edge` are
// quoted per $1,000 per-leg; we scale linearly to the user's capital. edge fields are
// null on the free tier (redacted) → <Redacted> shows the calm unlock, never a fake 0.

// Net $/day at the user's capital-per-leg, or null when the derived edge is redacted.
function perpSpotNetDay(row: PerpSpotRow, capitalPerLeg: number): number | null {
  if (row.edge.netPerDay1k == null) return null;
  return row.edge.netPerDay1k * (capitalPerLeg / 1000);
}

function PerpSpotRegimeBanner({ regime }: { regime: PerpSpotRegime }) {
  const hot = regime.state === 'HOT';
  const color  = hot ? '#0f766e' : '#6b7787';
  const bg     = hot ? '#effcf9' : '#f5f7fa';
  const border = hot ? '#bfe9df' : '#e6eaef';
  return (
    <div className="rounded-card mb-4 p-3" style={{ background: bg, border: `1px solid ${border}` }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 font-body font-semibold rounded-pill px-2 py-0.5"
          style={{ fontSize: 11, color: '#fff', background: color }}>
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: '#fff', opacity: 0.9 }} />
          {hot ? 'HOT' : 'CALM'}
        </span>
        <span className="font-body" style={{ fontSize: 12, color: '#334155' }}>
          {hot
            ? 'Most venues’ funding is above the 30-day fee hurdle — carry is workable now, though margins can be modest and can flip.'
            : 'Even the best rates are near the fee hurdle — thin pickings; funding tends to spike in high-volatility periods.'}
        </span>
      </div>
      <div className="mt-1.5 font-mono tabular-nums" style={{ fontSize: 10.5, color: '#6b7787' }}>
        top-quartile funding {regime.medianTopQuartilePct8h.toFixed(4)}%/8h vs breakeven {regime.feeBreakevenPct8h.toFixed(4)}%/8h
        {' · '}{regime.aboveBreakevenCount}/{regime.sampleCount} venues above the hurdle
      </div>
    </div>
  );
}

function PerpSpotExplainer() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-card bg-surface mb-4" style={{ border: '1px solid #e6eaef', boxShadow: '0 1px 2px rgba(14,22,38,.05)' }}>
      <div className="p-4">
        <div className="font-semibold text-ink" style={{ fontSize: 15 }}>Earn the funding — without betting on price</div>
        <p className="mt-1.5 font-body leading-relaxed" style={{ fontSize: 12.5, color: '#334155', maxWidth: '58ch' }}>
          You buy the coin (<strong>spot</strong>) and <strong>short</strong> an equal amount on its
          perpetual. Price moves cancel out — you keep the funding rate that long traders pay shorts,
          collected every settlement.
        </p>

        {/* 3 steps */}
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
          {[
            { n: '1', t: 'Buy spot', d: 'Buy the coin on a major spot venue with your capital.' },
            { n: '2', t: 'Short the perp', d: 'Open an equal-size short on the perp paying the most funding.' },
            { n: '3', t: 'Collect funding', d: 'Every settlement the shorts collect — price-neutral.' },
          ].map(s => (
            <div key={s.n} className="rounded-md p-2.5" style={{ border: '1px solid #eef2f6', background: '#fafcfd' }}>
              <div className="flex items-center gap-1.5">
                <span className="inline-flex items-center justify-center font-mono font-bold text-white shrink-0"
                  style={{ width: 16, height: 16, borderRadius: 999, background: '#0f766e', fontSize: 10 }}>{s.n}</span>
                <span className="font-body font-semibold text-ink" style={{ fontSize: 12 }}>{s.t}</span>
              </div>
              <p className="mt-1 font-body" style={{ fontSize: 11, color: '#6b7787', lineHeight: 1.45 }}>{s.d}</p>
            </div>
          ))}
        </div>

        {/* Honest warning box */}
        <div className="mt-3 rounded-md p-2.5" style={{ border: '1px solid #f6e4c8', background: '#fff8ef' }}>
          <div className="font-body font-semibold" style={{ fontSize: 11.5, color: '#b45309' }}>Before you trade</div>
          <ul className="mt-1 space-y-0.5 font-body" style={{ fontSize: 11, color: '#8a5a12', lineHeight: 1.5 }}>
            <li>• Funding can flip <strong>negative</strong> — then you <em>pay</em> instead of collect.</li>
            <li>• Rates shown are <strong>current, not guaranteed</strong>. They change every settlement.</li>
            <li>• The spot leg needs <strong>full capital</strong>; keep margin on the perp so it can&apos;t liquidate.</li>
          </ul>
        </div>

        <button onClick={() => setOpen(v => !v)}
          className="mt-2 font-body text-[11px] text-muted hover:text-ink-2 transition-colors">
          {open ? 'Hide the fine print ↑' : 'How we compute net / day ↓'}
        </button>
        {open && (
          <p className="mt-1.5 font-body" style={{ fontSize: 11, color: '#6b7787', lineHeight: 1.5, maxWidth: '58ch' }}>
            Funding collected/day = position size × funding rate × settlements/day. Fees are paid <strong>once</strong>
            {' '}(open + close both legs — real published taker rates), so <strong>net / day</strong> amortizes that fee
            over a 30-day hold. Shorter holds earn less; longer holds recover more of the fee. Annualized is a capped
            <em> run-rate</em>, not a promise.
          </p>
        )}
      </div>
    </div>
  );
}

// Numbered, plain-English playbook built from the row's REAL data. Spot leg goes
// FIRST on purpose: opening the short before you hold the coin leaves you net-short
// (directionally exposed) until the spot fill lands. Every $ / venue / interval is
// interpolated from the row — no placeholders, no invented numbers.
function PerpSpotHowTo({
  row, capitalPerLeg, perpUrl, spotUrl,
}: { row: PerpSpotRow; capitalPerLeg: number; perpUrl: string | null; spotUrl: string | null }) {
  const cap        = fmtMoneyPlain(capitalPerLeg);
  const spotName   = venueLabel(row.spotVenueSuggested);
  const shortName  = venueLabel(row.shortVenue);
  const beDays     = row.edge.breakevenDays;
  const beText     = beDays != null
    ? `Fees break even in ${beDays.toFixed(1)} days.`
    : 'Fees break even once collected funding covers the round-trip cost.';

  const steps = [
    {
      n: '1',
      t: 'Buy spot',
      leg: 'long leg',
      body: <>On <strong>{spotName}</strong>, buy <strong>{cap}</strong> of {row.coin} on the
        <strong> spot</strong> market (not futures). This is your <strong>long</strong> leg — do this
        one <em>first</em>: opening the short before you hold the coin leaves you exposed to price.</>,
      link: spotUrl && <PlatformLink href={spotUrl} label={`${spotName} spot`} compact className="shrink-0" />,
    },
    {
      n: '2',
      t: 'Short the perp',
      leg: 'short leg',
      body: <>On <strong>{shortName}</strong>, open a <strong>SHORT</strong> on {row.coin}-PERP for
        <strong> {cap}</strong> at <strong>1× leverage</strong> (no liquidation risk at 1×). This is
        your <strong>short</strong> leg — size it equal to the spot buy.</>,
      link: perpUrl && <PlatformLink href={perpUrl} label={`${shortName} perp`} compact className="shrink-0" />,
    },
    {
      n: '3',
      t: 'Hold & collect',
      leg: null as string | null,
      body: <>You&apos;re now price-neutral. Funding is paid to your short every <strong>{row.intervalH}h</strong>.
        {' '}{beText} Exit if funding flips negative — watch the <em>positive-for-N-settlements</em> chip on the card.</>,
      link: null,
    },
  ];

  return (
    <div className="mt-3 rounded-md p-3" style={{ border: '1px solid #e6eaef', background: '#fafcfd' }}>
      <div className="font-body font-semibold text-ink" style={{ fontSize: 12 }}>How to execute</div>
      <ol className="mt-2 flex flex-col gap-2.5">
        {steps.map(s => (
          <li key={s.n} className="flex items-start gap-2.5">
            <span className="inline-flex items-center justify-center font-mono font-bold text-white shrink-0 mt-[1px]"
              style={{ width: 18, height: 18, borderRadius: 999, background: '#0f766e', fontSize: 10.5 }}>{s.n}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-body font-semibold text-ink" style={{ fontSize: 12 }}>{s.t}</span>
                {s.leg && (
                  <span className="font-body px-1.5 py-[1px] rounded-pill shrink-0"
                    style={{ fontSize: 9, color: '#0f766e', background: '#effcf9' }}>{s.leg}</span>
                )}
                {/* deep link is a distinct tap target from the card toggle */}
                {s.link}
              </div>
              <p className="mt-0.5 font-body" style={{ fontSize: 11, color: '#475569', lineHeight: 1.5 }}>{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      {/* Gated auto-execute placeholder — inert, never wired to a real order flow.
          Live execution stays OFF (AUTO_EXECUTE_ENABLED=false): with the flag off we
          render the muted "coming soon" lock; even with it on there is deliberately no
          key-input surface here yet.
          TODO(api-keys): exchange API-key custody + hardening (encrypted-at-rest key
          storage, per-venue scopes, kill-switch) is a separate future milestone before
          any two-leg placement can ship. Do NOT wire an order path off this block. */}
      {!AUTO_EXECUTE_ENABLED && (
        <div
          aria-disabled
          title="Auto-execute — coming soon, not yet available"
          className="mt-2.5 rounded-md p-2.5 flex items-center gap-2.5 select-none"
          style={{ border: '1px dashed #cfd6df', background: 'transparent', cursor: 'not-allowed', opacity: 0.85 }}
        >
          <span aria-hidden className="shrink-0" style={{ fontSize: 13, lineHeight: 1 }}>🔒</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-body font-semibold" style={{ fontSize: 11.5, color: '#6b7787' }}>
                ⚡ Auto-execute via API
              </span>
              <span className="font-body uppercase tracking-widest"
                style={{ fontSize: 8, padding: '1px 5px', borderRadius: 4, color: '#6b7787', background: '#f1f5f9', border: '1px solid #e6eaef' }}>
                Coming soon
              </span>
            </div>
            <p className="font-body mt-0.5" style={{ fontSize: 10.5, color: '#9aa5b3', lineHeight: 1.45 }}>
              Connect your exchange API keys and Edgeradar will place both legs for you.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function PerpSpotCard({
  row, capitalPerLeg, expanded, onToggle,
}: { row: PerpSpotRow; capitalPerLeg: number; expanded: boolean; onToggle: () => void }) {
  const k          = capitalPerLeg / 1000;
  const netDay     = perpSpotNetDay(row, capitalPerLeg);
  const perpUrl    = venuePerpUrl(row.shortVenue, row.coin);
  const spotUrl    = venueSpotUrl(row.spotVenueSuggested, row.coin);
  const heroColor  = netDay == null ? '#0f766e' : netDay > 0 ? '#0f766e' : '#e11d48';
  const flipRisk   = row.trailingPositiveSettlements < 3;

  return (
    <div className="rounded-card bg-surface overflow-hidden" style={{ border: '1px solid #e6eaef', boxShadow: '0 1px 2px rgba(14,22,38,.05)' }}>
      <button onClick={onToggle} className="w-full text-left p-3 hover:bg-bg-soft/40 transition-colors">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-mono font-bold text-ink" style={{ fontSize: 17 }}>{row.coin}</span>
              {flipRisk && (
                <span className="font-body px-1.5 py-[1px] rounded-pill shrink-0" style={{ fontSize: 9, color: '#b45309', background: '#fff8ef' }}>
                  flip risk
                </span>
              )}
              {!row.spotVenueVerified && (
                <span className="font-body px-1.5 py-[1px] rounded-pill shrink-0" style={{ fontSize: 9, color: '#6b7787', background: '#f1f5f9' }}>
                  verify spot listing
                </span>
              )}
            </div>
            <div className="mt-1 font-mono tabular-nums break-words" style={{ fontSize: 11, color: '#6b7787', lineHeight: 1.5 }}>
              short perp <span className="text-ink-2 font-semibold">{venueLabel(row.shortVenue)}</span>
              {' · '}buy spot <span className="text-ink-2 font-semibold">{venueLabel(row.spotVenueSuggested)}</span>
              {' · '}funding <span style={{ color: '#0f766e' }}>+{row.fundingPct8h.toFixed(4)}%/8h</span>
              {row.edge.breakevenDays != null && (
                <>{' · '}breakeven {row.edge.breakevenDays.toFixed(1)}d</>
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              <span className="font-body px-1.5 py-[1px] rounded-pill" style={{ fontSize: 9.5, color: '#0f766e', background: '#effcf9' }}>
                positive for {row.trailingPositiveSettlements} settlement{row.trailingPositiveSettlements === 1 ? '' : 's'}
              </span>
              {perpUrl && <PlatformLink href={perpUrl} label={`${venueLabel(row.shortVenue)} perp`} compact className="shrink-0" />}
              {spotUrl && <PlatformLink href={spotUrl} label={`${venueLabel(row.spotVenueSuggested)} spot`} compact className="shrink-0" />}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="font-mono font-bold tabular-nums leading-none" style={{ fontSize: 20, color: heroColor }}>
              {netDay == null
                ? <Redacted value={row.edge.netPerDay1k}>{() => null}</Redacted>
                : `${netDay >= 0 ? '+' : ''}${fmtDayUsd(netDay).replace('/day', '')}`}
            </div>
            <div className="font-body mt-0.5" style={{ fontSize: 9.5, color: '#9aa5b3' }}>net / day</div>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t" style={{ borderColor: '#eef2f6' }}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono tabular-nums" style={{ fontSize: 11 }}>
            <span className="text-muted">Funding collected / day</span>
            <span className="text-right text-ink">
              <Redacted value={row.edge.grossPerDay1k}>{v => fmtDayUsd(v * k)}</Redacted>
            </span>

            <span className="text-muted">One-time fees (both legs)</span>
            <span className="text-right text-ink">
              <Redacted value={row.edge.feesOneTime1k}>{v => fmtMoneyPlain(v * k)}</Redacted>
            </span>

            <span className="text-muted">Breakeven</span>
            <span className="text-right text-ink">
              <Redacted value={row.edge.breakevenDays}>{v => `${v.toFixed(1)} days`}</Redacted>
            </span>

            <span className="text-muted">Net / day (30d hold)</span>
            <span className="text-right font-bold" style={{ color: heroColor }}>
              <Redacted value={row.edge.netPerDay1k}>{v => fmtDayUsd(v * k)}</Redacted>
            </span>

            <span className="text-muted">Capital needed (spot + 1× margin)</span>
            <span className="text-right text-ink">{fmtMoneyPlain(2 * capitalPerLeg)}</span>

            <span className="text-muted">Annualized (run-rate, capped)</span>
            <span className="text-right text-ink">
              <Redacted value={row.edge.annualizedRunRatePct}>
                {v => `${fmtApy(v)}${row.edge.annualizedCapped ? ' +' : ''}`}
              </Redacted>
            </span>

            <span className="text-muted">Net ROI on capital / yr</span>
            <span className="text-right text-ink">
              <Redacted value={row.edge.netAnnualizedOnCapitalPct}>{v => fmtApy(v)}</Redacted>
            </span>
          </div>

          <p className="mt-2.5 font-body" style={{ fontSize: 10.5, color: '#9aa5b3', lineHeight: 1.5 }}>
            Fees are paid once; funding accrues every {row.intervalH}h. Net / day amortizes the fee over a
            30-day hold — a shorter hold earns less, a longer hold recovers more of the fee. Perp taker
            {' '}{row.edge.perpFeePct.toFixed(3)}% · spot taker {row.edge.spotFeePct.toFixed(3)}% (per leg, real published rates).
            Annualized is a <em>run-rate</em>, not guaranteed — funding can flip negative.
          </p>

          <PerpSpotHowTo row={row} capitalPerLeg={capitalPerLeg} perpUrl={perpUrl} spotUrl={spotUrl} />
        </div>
      )}
    </div>
  );
}

function PerpSpotView({
  rows, stale, capitalPerLeg, regime,
}: { rows: PerpSpotRow[]; stale: boolean; capitalPerLeg: number; regime: PerpSpotRegime | null }) {
  const [selectedCoins, setSelectedCoins] = useState<Set<string> | null>(null); // null = all
  const [minNetDay, setMinNetDay]         = useState(0);
  const [openCoin, setOpenCoin]           = useState<string | null>(null);

  const coins = useMemo(() => Array.from(new Set(rows.map(r => r.coin))).sort(), [rows]);

  const visible = useMemo(() => {
    const arr = rows
      .filter(r => selectedCoins == null || selectedCoins.has(r.coin))
      .filter(r => {
        const nd = perpSpotNetDay(r, capitalPerLeg);
        // Rows whose net/day is redacted (free tier) can't be $-filtered → always pass.
        return nd == null || nd >= minNetDay;
      });
    // Sort by net/day when known; otherwise fall back to raw funding so ordering is stable.
    return arr.sort((a, b) => {
      const na = perpSpotNetDay(a, capitalPerLeg);
      const nb = perpSpotNetDay(b, capitalPerLeg);
      if (na != null && nb != null) return nb - na;
      if (na != null) return -1;
      if (nb != null) return 1;
      return b.fundingPct8h - a.fundingPct8h;
    });
  }, [rows, selectedCoins, minNetDay, capitalPerLeg]);

  return (
    <div>
      {regime && <PerpSpotRegimeBanner regime={regime} />}
      <PerpSpotExplainer />

      {/* FILTERS */}
      {rows.length > 0 && (
        <div className="rounded-card bg-surface p-3 mb-4 flex flex-col gap-3" style={{ border: '1px solid #e6eaef' }}>
          {/* coin chips */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-body uppercase shrink-0" style={{ fontSize: 10, letterSpacing: '0.12em', color: '#6b7787' }}>Coin</span>
            <button
              onClick={() => setSelectedCoins(null)}
              className="rounded-pill px-2 py-0.5 font-mono transition-colors"
              style={selectedCoins == null
                ? { fontSize: 11, border: '1px solid #0f766e', color: '#0f766e', background: '#effcf9' }
                : { fontSize: 11, border: '1px solid #e6eaef', color: '#6b7787' }}
            >All</button>
            {coins.map(c => {
              const on = selectedCoins != null && selectedCoins.has(c);
              return (
                <button
                  key={c}
                  onClick={() => setSelectedCoins(prev => {
                    const next = new Set(prev ?? []);
                    if (next.has(c)) next.delete(c); else next.add(c);
                    return next.size === 0 ? null : next;
                  })}
                  className="rounded-pill px-2 py-0.5 font-mono transition-colors"
                  style={on
                    ? { fontSize: 11, border: '1px solid #0f766e', color: '#0f766e', background: '#effcf9' }
                    : { fontSize: 11, border: '1px solid #e6eaef', color: '#6b7787' }}
                >{c}</button>
              );
            })}
          </div>

          {/* min net/day slider */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-body uppercase shrink-0" style={{ fontSize: 10, letterSpacing: '0.12em', color: '#6b7787' }}>Min net / day</span>
            <input
              type="range" min={0} max={20} step={0.5} value={minNetDay}
              onChange={e => setMinNetDay(parseFloat(e.target.value))}
              className="flex-1 min-w-[120px] accent-mint-deep"
              aria-label="Minimum net dollars per day"
            />
            <span className="font-mono tabular-nums shrink-0" style={{ fontSize: 12, color: '#0f766e' }}>
              ${minNetDay.toFixed(1)}/day
            </span>
          </div>
        </div>
      )}

      {/* Stale / empty states — shown calmly */}
      {stale && rows.length > 0 && (
        <div className="mb-3 font-body px-2.5 py-1.5 rounded-md" style={{ fontSize: 11, color: '#b45309', background: '#fff8ef', border: '1px solid #f6e4c8' }}>
          Funding feed is a few minutes stale — rates refresh shortly.
        </div>
      )}

      {rows.length === 0 ? (
        <div className="py-16 text-center">
          <div className="font-body text-ink" style={{ fontSize: 14 }}>No positive-funding coins right now</div>
          <p className="mt-1.5 font-body mx-auto" style={{ fontSize: 12, color: '#6b7787', maxWidth: '42ch' }}>
            Shorts only collect when funding is positive. When no venue is paying positive funding, there is
            nothing to harvest — that&apos;s normal in calm markets. Check back after the next settlement.
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="py-14 text-center font-body" style={{ fontSize: 12.5, color: '#6b7787' }}>
          No opportunities match your filters. Lower the min net / day or clear the coin selection.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5">
          {visible.map(row => (
            <PerpSpotCard
              key={`${row.coin}-${row.shortVenue}`}
              row={row}
              capitalPerLeg={capitalPerLeg}
              expanded={openCoin === row.coin}
              onToggle={() => setOpenCoin(c => (c === row.coin ? null : row.coin))}
            />
          ))}
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
  const [assetView,    setAssetView]    = useState<AssetClassView>('crypto');
  const pendingHashScroll               = useRef(false);
  const rafHandle                       = useRef<number | null>(null);

  // Restore persisted asset-class view (default 'crypto' — crypto view is byte-identical).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ASSET_CLASS_STORAGE_KEY);
      if (raw === 'crypto' || raw === 'commodity') setAssetView(raw);
    } catch { /* default crypto */ }
  }, []);
  const selectAssetView = useCallback((v: AssetClassView) => {
    setAssetView(v);
    try { localStorage.setItem(ASSET_CLASS_STORAGE_KEY, v); } catch { /* non-fatal */ }
  }, []);

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

  // Hero headline: best net $/day across the current opportunity set at the
  // user's capital (redaction-aware — null when the tier can't see the numbers).
  const bestNetDay = filteredPairs.reduce<number | null>((best, s) => {
    const nd = netDayForCapital(s, capital, leverage);
    if (nd == null) return best;
    return best == null || nd > best ? nd : best;
  }, null);

  const isPerpSpot   = assetView === 'crypto' && typeFilter === 'spot_perp';
  const perpSpotRows = data?.perpSpot ?? [];
  const bestPerpSpotNet = perpSpotRows.reduce<number | null>((best, r) => {
    const nd = perpSpotNetDay(r, capital);
    if (nd == null) return best;
    return best == null || nd > best ? nd : best;
  }, null);
  // free tier: edge redacted → show the lock instead of a number
  const perpSpotAllRedacted = perpSpotRows.length > 0 && perpSpotRows.every(r => r.edge.netPerDay1k == null);

  return (
    <div className="max-w-[1200px] mx-auto px-4 py-6">

      {/* TOP BAR */}
      <div className="flex items-center justify-between gap-3 pb-3 mb-4" style={{ borderBottom: '1px solid #e6eaef' }}>
        <div className="flex items-center gap-2 min-w-0">
          <span aria-hidden className="shrink-0" style={{ width: 14, height: 14, borderRadius: 999, background: 'linear-gradient(135deg,#14b8a6,#0f766e)' }} />
          <span className="font-semibold tracking-tight text-ink" style={{ fontSize: 15, fontFamily: 'Georgia, ui-serif, serif' }}>Edgeradar</span>
          <span className="font-body" style={{ fontSize: 12, color: '#9aa5b3' }}>Funding</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isStale && (
            <span className="font-body px-2 py-0.5 rounded-pill" style={{ fontSize: 10, color: '#b45309', background: '#fff8ef' }}>
              data {data?.staleMinutes}m old
            </span>
          )}
          {data?.generatedAt && (
            <span className="font-mono tabular-nums" style={{ fontSize: 11, color: '#9aa5b3' }}>
              {new Date(data.generatedAt).toLocaleTimeString('en-GB', { hour12: false })}
            </span>
          )}
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill font-body font-medium" style={{ fontSize: 10, color: '#0f766e', background: '#effcf9' }}>
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: '#14b8a6' }} />live
          </span>
        </div>
      </div>

      {/* HERO */}
      <div className="pb-5 mb-5" style={{ borderBottom: '1px solid #e6eaef' }}>
        <div className="font-body uppercase" style={{ fontSize: 10, letterSpacing: '0.16em', color: '#9aa5b3' }}>
          {isPerpSpot ? 'Perp vs Spot · delta-neutral carry' : 'Funding arbitrage · market-neutral'}
        </div>
        <div className="mt-2 flex items-baseline gap-2 flex-wrap">
          {/* Commodities are observation-only — no cashable "best net/day" exists, so dash it. */}
          <span className="font-mono font-bold tabular-nums leading-none" style={{ fontSize: 38, color: '#0f766e' }}>
            {assetView === 'commodity'
              ? '—'
              : isPerpSpot
                ? (perpSpotRows.length === 0
                    ? '—'
                    : bestPerpSpotNet != null
                      ? `≈ ${fmtMoneyPlain(bestPerpSpotNet)}`
                      : perpSpotAllRedacted
                        ? <span className="align-middle"><Redacted value={null}>{() => null}</Redacted></span>
                        : '—')
                : filteredPairs.length === 0
                  ? '—'
                  : bestNetDay != null
                    ? `≈ ${fmtMoneyPlain(bestNetDay)}`
                    : <span className="align-middle"><Redacted value={filteredPairs[0].netApy30d}>{() => null}</Redacted></span>}
          </span>
          <span className="font-body" style={{ fontSize: 12, color: '#6b7787' }}>
            {assetView === 'commodity'
              ? 'commodities · observing funding, not cashable yet'
              : isPerpSpot
                ? `best net / day on $${capital.toLocaleString()} per leg`
                : `best net / day on $${capital.toLocaleString()}`}
          </span>
        </div>
        <p className="mt-3 font-body leading-relaxed" style={{ fontSize: 12.5, color: '#334155', maxWidth: '54ch' }}>
          {isPerpSpot
            ? 'Hold spot, short the same coin’s perp on the venue paying the most funding. Price moves cancel — you keep the full funding rate. Rates are current, not locked, and can flip negative.'
            : 'Short the exchange paying high funding, long the one paying low. You take no bet on price — you keep the hourly funding gap. Rates are current estimates, not locked.'}
        </p>
      </div>

      {/* How this works — collapsible, collapsed by default */}
      <SectionHelp section="funding" />

      {loading ? (
        <div className="py-20 text-center font-body text-sm text-muted animate-pulse">
          Loading…
        </div>
      ) : !data?.ok ? (
        <div className="py-20 text-center space-y-2">
          <div className="font-body text-sm text-coral-ink">No data</div>
          <div className="font-mono text-[10px] text-muted/70">
            pm2 start ecosystem.config.js --only agent10-binance
          </div>
        </div>
      ) : (
        <>
          {/* CONTROLS — capital drives every card's net/day live */}
          <div className="mb-5 rounded-card bg-surface p-3 flex flex-col gap-3" style={{ border: '1px solid #e6eaef', boxShadow: '0 1px 2px rgba(14,22,38,.05)' }}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-body uppercase shrink-0" style={{ fontSize: 10, letterSpacing: '0.12em', color: '#6b7787' }}>{typeFilter === 'spot_perp' ? 'Capital per leg' : 'Your capital'}</span>
              <div className="inline-flex items-center rounded-button overflow-hidden" style={{ border: '1px solid #e6eaef' }}>
                <span className="pl-2.5 pr-1 font-mono" style={{ fontSize: 13, color: '#9aa5b3' }}>$</span>
                <input
                  inputMode="numeric"
                  aria-label="Capital in dollars"
                  value={capital || ''}
                  onChange={e => {
                    const d = e.target.value.replace(/[^0-9]/g, '');
                    setCapital(d ? Math.min(1_000_000_000, parseInt(d, 10)) : 0);
                  }}
                  className="w-24 py-2 pr-2 font-mono tabular-nums bg-transparent text-ink focus:outline-none"
                  style={{ fontSize: 13 }}
                />
              </div>
              <div className="flex items-center gap-1">
                {(typeFilter === 'spot_perp' ? [500, 1000, 5000, 10000] : [1000, 5000, 10000]).map(v => (
                  <button
                    key={v}
                    onClick={() => setCapital(v)}
                    className="rounded-button transition-colors duration-100 font-mono"
                    style={{
                      fontSize: 11, padding: '7px 9px',
                      ...(capital === v
                        ? { border: '1px solid #0f766e', color: '#0f766e', background: '#effcf9' }
                        : { border: '1px solid #e6eaef', color: '#6b7787' }),
                    }}
                  >
                    {v >= 1000 ? `${v / 1000}k` : `$${v}`}
                  </button>
                ))}
              </div>
            </div>

            {/* Framing note — perp/perp uses stablecoin margin; perp-spot buys real spot */}
            {typeFilter === 'spot_perp' ? (
              <p className="font-body" style={{ fontSize: 11, color: '#9aa5b3', marginTop: -6 }}>
                = capital on EACH leg. You buy spot with one leg and post margin on the short perp with the
                other, so total capital deployed is 2×.
              </p>
            ) : (
              <p className="font-body" style={{ fontSize: 11, color: '#9aa5b3', marginTop: -6 }}>
                = USD stablecoin margin (USDC/USDT). You open perp positions — you don&apos;t buy the coin.
              </p>
            )}

            {/* Secondary controls */}
            <div className="flex items-center gap-4 flex-wrap pt-2.5" style={{ borderTop: '1px solid #eef2f6' }}>
              <AssetClassToggle value={assetView} onChange={selectAssetView} />
              <TypeFilterToggle value={typeFilter} onChange={setTypeFilter} />
              {typeFilter !== 'spot_perp' && (
              <div className="flex items-center gap-2">
                <span className="font-body uppercase" style={{ fontSize: 10, letterSpacing: '0.12em', color: '#6b7787' }}>Leverage</span>
                <div className="flex rounded-button overflow-hidden" style={{ border: '1px solid #e6eaef' }}>
                  {LEVERAGE_OPTIONS.map(lev => (
                    <button
                      key={lev}
                      onClick={() => setLeverage(lev)}
                      title={lev === 1
                        ? '1× — no leverage. Each leg sized to your full capital.'
                        : `${lev}× — both perp legs use ${lev}× margin. Funding yield and liquidation risk both scale ${lev}×.`}
                      className="px-2 py-1 font-mono cursor-help transition-colors duration-100"
                      style={leverage === lev ? { fontSize: 11, background: '#0f766e', color: '#fff' } : { fontSize: 11, color: '#6b7787' }}
                    >
                      {lev}×
                    </button>
                  ))}
                </div>
                {leverage > 1 && (
                  <span className="font-body" style={{ fontSize: 10, color: '#b45309' }}>liquidation risk if basis widens</span>
                )}
              </div>
              )}
            </div>
          </div>

          {/* Crypto view → cards + advanced table; Commodities view → RWA observation strip */}
          {assetView === 'crypto' && typeFilter === 'spot_perp' && (
            <PerpSpotView rows={data.perpSpot ?? []} stale={!!data.perpSpotStale} capitalPerLeg={capital} regime={data.perpSpotRegime ?? null} />
          )}
          {assetView === 'crypto' && typeFilter !== 'spot_perp' && (
            <OpportunityCards spreads={filteredPairs} capital={capital} leverage={leverage} />
          )}
          {assetView === 'commodity' && (
            <RwaCommoditiesStrip rows={data.rwa ?? []} />
          )}

          {/* ── Advanced / full data (crypto perp/perp view only) ─────────── */}
          {assetView === 'crypto' && typeFilter !== 'spot_perp' && (
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

                  {filteredPairs.length > 0 ? (
                    <div className="px-2.5 py-1 border border-mint/30 bg-mint-tint/30 rounded-md font-body text-[11px] text-mint-deep">
                      <Redacted value={filteredPairs[0].netApy30d}>
                        {netApy30d => capital > 0 ? (
                          <>
                            Best: <span className="font-bold">{fmtDayUsd((N0 * netApy30d / 100) / 365)}</span>
                            <span className="text-[10px] text-mint-deep/60 ml-1">on ${capital.toLocaleString()}</span>
                          </>
                        ) : (
                          <span title="Theoretical ceiling — rate changes hourly.">
                            Best ceiling: <span className="font-bold">{fmtApy(Math.min(netApy30d, APY_CAP))}</span>
                          </span>
                        )}
                      </Redacted>
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
          )}
        </>
      )}
    </div>
  );
}
