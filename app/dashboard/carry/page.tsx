'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RefreshCw, ChevronRight } from 'lucide-react';
import Eyebrow from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import StatCard from '@/app/components/ui/StatCard';
import EdgeChip from '@/app/components/ui/EdgeChip';
import { Redacted } from '@/app/components/ui/Redacted';
import InfoDot from '@/app/components/ui/InfoDot';
import { type Contract, chipVariant } from '@/lib/carry';

// ─────────────────────────────────────────────────────────────────────────────
// Cash & Carry (Spot + Dated Futures Basis) — filter-rich, light-theme desk view
// matching /dashboard/sports · /paper · /traders.
//
// HONEST-ENGINE (unchanged — layout + filters only, no number/tier/API change):
//   • Every filter/sort ranks on a REAL served field. Fields the agent doesn't
//     produce (e.g. XPERP flag) → the filter is OMITTED, never fabricated.
//   • Derived $ (basis %, net %/yr, capacity, verdict) are server-nulled for the
//     free tier (REDACTION_MAP.carry) → <Redacted> lock. Public: asset, venue,
//     expiry, days, volume, margin-type, structure, counts. Gated-field filters
//     only EXCLUDE a row when the field is actually visible (paid) — on the free
//     tier they can't hide rows behind data you can't see (honest degrade).
//   • net %/yr = run-rate to expiry, net-of-fee, capped at 200%/yr — never a
//     guarantee. capacity = order-book/turnover estimate. Backwardation (negative
//     carry) is shown honestly, never silently dropped (a user toggle hides it).
// ─────────────────────────────────────────────────────────────────────────────

// ── Types ─────────────────────────────────────────────────────────────────────
interface BackwardContract {
  asset:               string;
  exchange:            string;
  contract:            string;
  expiry:              string;
  daysToExpiry:        number;
  spot:                number;
  future:              number;
  spotAsk:             number | null;
  futureBid:           number | null;
  indicativeBasisPct:  number | null;
  executableBasisPct:  number | null;
  basis:               number | null;
  annualized:          number | null;
  vol24Usd:            number;
  signal:              string;
}

interface Summary {
  count:             number;
  bestNetAnnualized: number | null;
  bestContract:      string | null;
  bestExchange:      string | null;
  bestAsset:         string | null;
}

interface CarryData {
  agentStatus:   'running' | 'stale' | 'offline';
  updatedAt:     string | null;
  opportunities: Contract[];
  backwardation: BackwardContract[];
  summary:       Summary;
  spot:          Record<string, number | null>;
  disclaimer:    string;
  isPaid:        boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const APY_CAP = 2.0; // 200%/yr cap (honest-engine — never show >200%/yr as a guarantee)
function capApy(n: number): { display: number; capped: boolean } {
  return n > APY_CAP ? { display: APY_CAP, capped: true } : { display: n, capped: false };
}
function fmtAnnualized(n: number, prefix = '+'): string {
  const { display } = capApy(n);
  const sign = display >= 0 ? prefix : '';
  return `${sign}${(display * 100).toFixed(2)}%`;
}
function fmtBasis(n: number): string { return `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(2)}%`; }
function fmtK(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}
function fmtPrice(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.round(s)}s ago`;
  return `${Math.round(s / 60)}m ago`;
}
function coinEmoji(asset: string): string {
  if (asset === 'BTC') return '₿';
  if (asset === 'ETH') return 'Ξ';
  if (asset === 'BNB') return '◆';
  if (asset === 'SOL') return '◎';
  return '○';
}
// Real expiry → "Jun '27" bucket label (public field, never fabricated).
function expiryLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} '${String(d.getUTCFullYear()).slice(2)}`;
}
const netColor = (n: number | null | undefined): string =>
  n == null ? 'text-muted' : n > 0 ? 'text-mint-deep' : n < 0 ? 'text-coral-ink' : 'text-ink-2';

// ── Sort keys (each ranks on a real served field) ─────────────────────────────
type SortKey = 'net' | 'basis' | 'days' | 'volume' | 'capacity';
const SORT_LABEL: Record<SortKey, string> = { net: 'net %/yr', basis: 'basis %', days: 'days', volume: 'volume', capacity: 'capacity' };
const SORT_TITLE: Record<SortKey, string> = {
  net:      'net-of-fee annualized basis (run-rate to expiry, capped 200%/yr) — gated on free tier',
  basis:    'executable spot↔future basis % — gated on free tier',
  days:     'days to expiry — soonest first (public field)',
  volume:   '24h futures volume (public field)',
  capacity: 'order-book / turnover capacity estimate — gated on free tier',
};
function sortVal(c: Contract, k: SortKey): number | null {
  if (k === 'net')      return c.netAnnualizedExecutable;
  if (k === 'basis')    return c.executableBasisPct ?? c.basis;
  if (k === 'days')     return c.daysToExpiry;
  if (k === 'volume')   return c.vol24Usd;
  return c.capacityUsd;
}

// ── Filter/sort pill ──────────────────────────────────────────────────────────
function Pill({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button onClick={onClick} title={title}
      className={[
        'font-body text-[11px] px-2.5 py-1 rounded-button border whitespace-nowrap transition-colors',
        active ? 'text-mint-deep border-mint-deep/50 bg-mint-tint' : 'text-muted border-line bg-surface hover:text-ink-2',
      ].join(' ')}>
      {children}
    </button>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────
function RowSkeleton() {
  return (
    <div className="rounded-card shadow-card bg-surface px-4 py-3 animate-pulse mb-2">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-bg-soft rounded-[10px] shrink-0" />
        <div className="flex-1 space-y-2"><div className="h-3 w-32 bg-bg-soft rounded" /><div className="h-2.5 w-24 bg-bg-soft rounded" /></div>
        <div className="h-5 w-14 bg-bg-soft rounded" />
      </div>
    </div>
  );
}

// ── Contract row (contango) — compact + expand to full detail ─────────────────
function DetailCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-bg-soft border border-line px-2.5 py-2">
      <p className="font-body text-[9px] uppercase tracking-wide text-muted mb-0.5">{label}</p>
      <p className="font-body text-[12px] text-ink-2 tabular-nums leading-tight">{children}</p>
    </div>
  );
}

function ContractRow({ c, isPaid, open, onToggle }: { c: Contract; isPaid: boolean; open: boolean; onToggle: () => void }) {
  const dash = <span className="text-muted">—</span>;
  const chip = chipVariant(c);
  const capped = (c.netAnnualizedExecutable != null && capApy(c.netAnnualizedExecutable).capped);
  return (
    <div className="border-b border-line">
      <button onClick={onToggle} className="w-full grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-3 py-2.5 text-left hover:bg-bg-soft/60 transition-colors">
        <span className="w-8 h-8 rounded-[9px] bg-bg-soft border border-line grid place-items-center text-[15px] shrink-0">{coinEmoji(c.asset)}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 flex-wrap">
            <span className="font-body text-[12.5px] font-medium text-ink">{c.asset}</span>
            <span className="inline-flex items-center gap-0.5">
              <span className="font-body text-[9px] uppercase tracking-wide px-1 rounded border border-line text-muted bg-surface">{c.coinMargined ? 'coin-margin' : 'USD-margin'}</span>
              {/* educational only — reads from the shared glossary; never changes the tier.
                  InfoTip stops click propagation itself, so the dot never toggles the row. */}
              <InfoDot term={c.coinMargined ? 'coin_margined' : 'usdt_margined'} size={11} />
            </span>
            <EdgeChip variant={chip} />
          </span>
          <span className="font-body text-[10px] text-muted truncate block">{c.exchange} · {expiryLabel(c.expiry)} · {c.daysToExpiry}d</span>
        </span>
        <span className="text-right tabular-nums shrink-0">
          <span className={`block font-body text-[13px] font-semibold ${netColor(c.netAnnualizedExecutable)}`}>
            <Redacted value={c.netAnnualizedExecutable} isPaid={isPaid}>{v => fmtAnnualized(v as number)}</Redacted>
          </span>
          <span className="block font-body text-[8.5px] uppercase tracking-wide text-muted">net · run-rate{capped ? ' · capped' : ''}</span>
        </span>
        <ChevronRight className={`w-3.5 h-3.5 text-muted shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="px-3 pb-3 pt-0.5 bg-bg-soft/40">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            <DetailCell label="Raw basis"><Redacted value={c.executableBasisPct ?? c.basis} isPaid={isPaid}>{v => fmtBasis(v as number)}</Redacted></DetailCell>
            <DetailCell label="Net %/yr (exec.)"><span className={netColor(c.netAnnualizedExecutable)}><Redacted value={c.netAnnualizedExecutable} isPaid={isPaid}>{v => fmtAnnualized(v as number)}</Redacted></span></DetailCell>
            <DetailCell label="Days to expiry">{c.daysToExpiry}d · {c.expiry}</DetailCell>
            <DetailCell label="Margin type">
              <span className="inline-flex items-center gap-1">
                {c.coinMargined ? 'Coin (inverse)' : 'USD (clean)'}
                <InfoDot term={c.coinMargined ? 'coin_margined' : 'usdt_margined'} size={11} />
              </span>
            </DetailCell>
            <DetailCell label="24h volume">{fmtK(c.vol24Usd)}</DetailCell>
            <DetailCell label="Capacity">
              <Redacted value={c.capacityUsd} isPaid={isPaid}>{v => fmtK(v as number)}</Redacted>
              <span className="text-muted"> · {c.capacitySource ?? '—'}</span>
            </DetailCell>
            <DetailCell label="Structure">Contango</DetailCell>
            <DetailCell label="Settlement">deterministic @ expiry</DetailCell>
          </div>

          {/* how to execute — reuses real fields; gated numbers stay locked */}
          <div className="rounded-lg bg-surface border border-line px-3 py-2 mt-1.5">
            <p className="font-body text-[9px] uppercase tracking-wide text-muted mb-1">How to execute</p>
            <p className="font-body text-[11.5px] text-ink-2 leading-snug">
              Buy spot <b>{c.asset}</b>, short the {expiryLabel(c.expiry)} <b>{c.exchange}</b> future{' '}
              (<span className="font-mono">{c.contract}</span>) @ <Redacted value={c.executableBasisPct ?? c.basis} isPaid={isPaid}>{v => fmtBasis(v as number)}</Redacted> basis;
              {' '}hold to expiry ({c.daysToExpiry}d) → ~<span className={netColor(c.netAnnualizedExecutable)}><Redacted value={c.netAnnualizedExecutable} isPaid={isPaid}>{v => fmtAnnualized(v as number)}</Redacted></span>/yr net-of-fee,
              {' '}cap ~<Redacted value={c.capacityUsd} isPaid={isPaid}>{v => fmtK(v as number)}</Redacted>.
              {c.coinMargined && <span className="text-gold"> Coin-settled — USD return drifts with spot, not a clean locked-USD trade.</span>}
            </p>
            {c.verdict != null && (
              <p className="font-body text-[10.5px] text-muted mt-1"><Redacted value={c.verdict} isPaid={isPaid}>{v => v as string}</Redacted></p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Backwardation row — negative carry, shown honestly ────────────────────────
function BackRow({ c, isPaid, open, onToggle }: { c: BackwardContract; isPaid: boolean; open: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-line">
      <button onClick={onToggle} className="w-full grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-3 py-2.5 text-left hover:bg-bg-soft/60 transition-colors">
        <span className="w-8 h-8 rounded-[9px] bg-bg-soft border border-line grid place-items-center text-[15px] shrink-0">{coinEmoji(c.asset)}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 flex-wrap">
            <span className="font-body text-[12.5px] font-medium text-ink">{c.asset}</span>
            <span className="font-body text-[9px] uppercase tracking-wide px-1 rounded border border-coral-ink/30 text-coral-ink bg-coral-tint">backwardation</span>
          </span>
          <span className="font-body text-[10px] text-muted truncate block">{c.exchange} · {expiryLabel(c.expiry)} · {c.daysToExpiry}d</span>
        </span>
        <span className="text-right tabular-nums shrink-0">
          <span className="block font-body text-[13px] font-semibold text-coral-ink"><Redacted value={c.annualized} isPaid={isPaid}>{v => fmtAnnualized(v as number, '')}</Redacted></span>
          <span className="block font-body text-[8.5px] uppercase tracking-wide text-muted">annualized basis</span>
        </span>
        <ChevronRight className={`w-3.5 h-3.5 text-muted shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0.5 bg-bg-soft/40">
          <div className="rounded-lg bg-coral-tint border border-coral-ink/20 px-3 py-2 mb-1.5">
            <p className="font-body text-[11px] text-coral-ink leading-snug">Negative carry — futures trade below spot. Standard cash &amp; carry loses money here; this is <b>not</b> a cash&amp;carry opportunity.</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-1.5">
            <DetailCell label="Raw basis"><Redacted value={c.executableBasisPct ?? c.basis} isPaid={isPaid}>{v => fmtBasis(v as number)}</Redacted></DetailCell>
            <DetailCell label="Annualized"><span className="text-coral-ink"><Redacted value={c.annualized} isPaid={isPaid}>{v => fmtAnnualized(v as number, '')}</Redacted></span></DetailCell>
            <DetailCell label="Days to expiry">{c.daysToExpiry}d · {c.expiry}</DetailCell>
            <DetailCell label="24h volume">{fmtK(c.vol24Usd)}</DetailCell>
            <DetailCell label="Net %/yr">—<span className="text-muted"> · n/a</span></DetailCell>
            <DetailCell label="Capacity">—<span className="text-muted"> · not measured</span></DetailCell>
          </div>
          <div className="rounded-lg bg-surface border border-line px-3 py-2">
            <p className="font-body text-[9px] uppercase tracking-wide text-muted mb-1">Signal</p>
            <p className="font-body text-[11.5px] text-ink-2 leading-snug">{c.signal}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Honesty disclosures ───────────────────────────────────────────────────────
const DISCLOSURES = [
  { label: 'Locked only at expiry.', body: 'The basis return is fixed at entry IF you hold the spot + futures position until contract expiry on the same exchange. Closing early re-buys the future at an unknown price — the locked return disappears.' },
  { label: 'USDT-M only = clean USD.', body: 'Only USDT-settled quarterlies lock a clean USD P&L. COIN-M / OKX BTC-USD / ETH-USD settle in the coin: if the coin falls 10% your USD return shrinks ~10% even though the basis held.' },
  { label: 'Capacity is an estimate.', body: 'Capacity = min(5% of 24h vol, 2% of OI, $500k). A rough execution bound — actual fill at size may move the basis. BNB is hard-capped at $50k.' },
  { label: 'Annualized ≠ guaranteed.', body: "Net %/yr is a run-rate to expiry, net-of-fee, capped at 200%/yr — today's contango snapshot, not a long-run yield. It compresses toward funding in calm markets." },
  { label: 'Not financial advice.', body: 'Exchange / counterparty risk over the full hold. Read-only scanner — no orders placed. Verify all numbers on-exchange before trading.' },
];
function HonestyBlock() {
  return (
    <div className="rounded-card shadow-card bg-surface px-5 py-5">
      <p className="font-body text-[11px] uppercase tracking-wide text-muted mb-4">Honesty disclosures</p>
      <div className="space-y-3">
        {DISCLOSURES.map(({ label, body }) => (
          <div key={label} className="flex gap-3">
            <span className="shrink-0 text-muted font-body text-[12px] mt-0.5">—</span>
            <p className="font-body text-[12px] text-muted leading-relaxed"><span className="text-ink-2 font-medium">{label}</span>{' '}{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── URL persistence (client-only; no useSearchParams → no Suspense needed) ─────
const readQP = () => (typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search));

// ── Page ──────────────────────────────────────────────────────────────────────
export default function CarryPage() {
  const [data,    setData]    = useState<CarryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // filter/sort state — initialized from the URL, mirrored back on change.
  const qp0 = readQP();
  const [sortKey, setSortKey]   = useState<SortKey>((['basis','days','volume','capacity'].includes(qp0.get('sort') ?? '') ? qp0.get('sort') : 'net') as SortKey);
  const [asset, setAsset]       = useState(qp0.get('asset') ?? '');
  const [exch, setExch]         = useState(qp0.get('exch') ?? '');
  const [expiry, setExpiry]     = useState(qp0.get('exp') ?? '');
  const [execOnly, setExecOnly] = useState(qp0.get('exec') === '1');
  const [capMin, setCapMin]     = useState(qp0.get('cap') === '1');
  const [usdOnly, setUsdOnly]   = useState(qp0.get('usd') === '1');
  const [hideBack, setHideBack] = useState(qp0.get('hb') === '1');
  const [minNet, setMinNet]     = useState(() => { const n = Number(qp0.get('minNet')); return Number.isFinite(n) && n > 0 ? n : 0; });
  const [maxDays, setMaxDays]   = useState<number | null>(() => { const n = Number(qp0.get('maxDays')); return Number.isFinite(n) && n > 0 ? n : null; });
  const [minVol, setMinVol]     = useState(() => { const n = Number(qp0.get('minVol')); return Number.isFinite(n) && n > 0 ? n : 0; });
  const [openId, setOpenId]     = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch('/api/carry');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);

  // mirror filter state → URL (replaceState, no history spam)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams();
    if (sortKey !== 'net') p.set('sort', sortKey);
    if (asset)   p.set('asset', asset);
    if (exch)    p.set('exch', exch);
    if (expiry)  p.set('exp', expiry);
    if (execOnly) p.set('exec', '1');
    if (capMin)  p.set('cap', '1');
    if (usdOnly) p.set('usd', '1');
    if (hideBack) p.set('hb', '1');
    if (minNet > 0)  p.set('minNet', String(minNet));
    if (maxDays)     p.set('maxDays', String(maxDays));
    if (minVol > 0)  p.set('minVol', String(minVol));
    const qs = p.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [sortKey, asset, exch, expiry, execOnly, capMin, usdOnly, hideBack, minNet, maxDays, minVol]);

  const isRunning = data?.agentStatus === 'running';
  const isStale   = data?.agentStatus === 'stale';
  const isOffline = data?.agentStatus === 'offline';
  const isPaid    = data?.isPaid ?? false;

  const allOpps = useMemo(() => data?.opportunities ?? [], [data]);
  const allBack = useMemo(() => data?.backwardation ?? [], [data]);

  // Real facet values present in the served data (never a hardcoded menu).
  const assets    = useMemo(() => Array.from(new Set([...allOpps, ...allBack].map(c => c.asset))).sort(), [allOpps, allBack]);
  const exchanges = useMemo(() => Array.from(new Set(allOpps.map(c => c.exchange))).sort(), [allOpps]);
  const expiries  = useMemo(() => Array.from(new Set(allOpps.map(c => c.expiry))).sort(), [allOpps]);

  // Public facet filters apply everywhere; gated-field filters (exec/cap/minNet)
  // only EXCLUDE when the field is visible (paid) — free tier can't hide on locked data.
  const facet = (c: { asset: string; exchange: string; expiry: string; daysToExpiry: number; vol24Usd: number }) =>
    (!asset  || c.asset === asset) &&
    (!exch   || c.exchange === exch) &&
    (!expiry || c.expiry === expiry) &&
    (maxDays == null || c.daysToExpiry <= maxDays) &&
    (minVol <= 0 || c.vol24Usd >= minVol);

  const rows = useMemo(() => {
    const list = allOpps.filter(c => {
      if (!facet(c)) return false;
      if (usdOnly && c.coinMargined) return false;
      if (execOnly && c.executableBasisPct != null && chipVariant(c) !== 'cashable') return false; // visible-only
      if (capMin && c.capacityUsd != null && c.capacityUsd < 100_000) return false;                // visible-only
      if (minNet > 0 && c.netAnnualizedExecutable != null && c.netAnnualizedExecutable < minNet / 100) return false; // visible-only
      return true;
    });
    const asc = sortKey === 'days';
    return list.slice().sort((a, b) => {
      const av = sortVal(a, sortKey), bv = sortVal(b, sortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1; // nulls last
      return asc ? av - bv : bv - av;
    });
  }, [allOpps, asset, exch, expiry, maxDays, minVol, usdOnly, execOnly, capMin, minNet, sortKey]);

  const backRows = useMemo(() => hideBack ? [] : allBack.filter(facet), [allBack, hideBack, asset, exch, expiry, maxDays, minVol]);

  // Hero: best clean-USD executable net/yr over the FULL set (summary stat, not the view).
  const bestClean = useMemo(() => {
    const v = allOpps.filter(c => !c.coinMargined).map(c => c.netAnnualizedExecutable).filter((x): x is number => x != null);
    return v.length ? Math.max(...v) : null;
  }, [allOpps]);
  const bestDisplay = bestClean ?? (data?.summary.bestNetAnnualized ?? null);
  const cleanCount = allOpps.filter(c => !c.coinMargined).length;
  const coinCount  = allOpps.filter(c => c.coinMargined).length;

  const filtersActive = !!(asset || exch || expiry || execOnly || capMin || usdOnly || hideBack || minNet || maxDays || minVol);
  const resetFilters = () => { setAsset(''); setExch(''); setExpiry(''); setExecOnly(false); setCapMin(false); setUsdOnly(false); setHideBack(false); setMinNet(0); setMaxDays(null); setMinVol(0); };

  return (
    <div className="dash-container px-4 py-8 font-body">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
        <div>
          <Eyebrow className="mb-1">Cash &amp; Carry</Eyebrow>
          <SectionHeading as="h1" className="text-2xl">Spot + Dated Futures Basis</SectionHeading>
          <p className="font-body text-[13px] text-muted mt-1">Buy spot, short a dated future → capture the basis, deterministic at expiry. Refreshes every 5 min.</p>
        </div>
        <div className="flex items-center gap-3">
          {data?.updatedAt && <span className="font-body text-[12px] text-muted">{fmtAge(data.updatedAt)}</span>}
          <button onClick={load} aria-label="Refresh" className="p-2 rounded-button border border-line text-muted hover:text-ink-2 hover:border-mint/40 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Beginner intro — the two margin types at a glance. Additive/educational,
          reads its term definitions from the shared glossary (lib/glossary.ts). */}
      <div className="mb-5 px-3.5 py-2.5 rounded-card border border-line bg-bg-soft/60">
        <p className="font-body text-[11.5px] text-muted leading-relaxed">
          <span className="text-ink-2 font-medium">Two contract types.</span>{' '}
          <span className="text-ink-2 font-medium">USDT-margined</span>
          <InfoDot term="usdt_margined" size={11} className="mx-0.5" />
          (collateral in dollars — simple, predictable, labeled <span className="text-mint-deep font-medium">Cashable</span>) and{' '}
          <span className="text-ink-2 font-medium">coin-margined / inverse</span>
          <InfoDot term="coin_margined" size={11} className="mx-0.5" />
          (collateral in the coin itself — riskier, non-linear, labeled <span className="text-gold font-medium">Speculative</span>).
          Filter <span className="text-ink-2 font-medium">“USD-margin only”</span> to see just the clean ones.
        </p>
      </div>

      {/* Banners */}
      {error && <div className="mb-4 px-4 py-3 rounded-card border border-coral-ink/25 bg-coral-tint font-body text-sm text-coral-ink">{error}</div>}
      {isStale && <div className="mb-4 px-4 py-3 rounded-card border border-gold/25 bg-gold-tint font-body text-sm text-gold">Data is stale — agent19-basis may have missed a run. Last update: {fmtAge(data?.updatedAt ?? null)}</div>}
      {isOffline && !loading && <div className="mb-4 px-4 py-3 rounded-card border border-line bg-surface font-body text-sm text-muted">agent19-basis offline — <code className="text-ink-2 font-mono text-[12px]">pm2 start agents/ecosystem.config.js --only agent19-basis</code></div>}

      {/* Hero stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <StatCard label="Best net/yr (executable)" value={bestDisplay != null ? fmtAnnualized(bestDisplay) : '—'}
          note={bestDisplay != null ? `${data?.summary.bestAsset ?? ''} · ${data?.summary.bestExchange ?? ''}` : 'no qualifying contracts'} />
        <StatCard label="Contracts qualifying" value={`${allOpps.length}`} note={`${cleanCount} clean USD · ${coinCount} coin-margined`} />
        <StatCard label="Backwardation" value={`${allBack.length}`} note="futures below spot — carry inverted" />
        <StatCard label="Agent" value={isRunning ? 'Live' : isStale ? 'Stale' : 'Offline'} note={data?.updatedAt ? fmtAge(data.updatedAt) : 'no data'} />
      </div>

      {/* Spot strip */}
      {data?.spot && Object.keys(data.spot).length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 mb-5">
          {Object.entries(data.spot).map(([a, price]) => price != null ? (
            <span key={a} className="font-body text-[12px] text-muted">{a} <span className="text-ink-2 font-medium">${(price as number).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></span>
          ) : null)}
        </div>
      )}

      {loading && !data && <div>{Array.from({ length: 3 }).map((_, i) => <RowSkeleton key={i} />)}</div>}

      {data && allOpps.length > 0 && (
        <>
          {/* Sort + top toggles */}
          <div className="flex items-center gap-3 flex-wrap mb-2">
            <span className="font-body text-[10px] uppercase tracking-wide text-muted">Sort</span>
            {(Object.keys(SORT_LABEL) as SortKey[]).map(k => (
              <button key={k} onClick={() => setSortKey(k)} title={SORT_TITLE[k]}
                className={['font-body text-[11px] uppercase tracking-wide pb-0.5 border-b-2 transition-colors', sortKey === k ? 'text-ink border-[#0c9d6e]' : 'text-muted border-transparent hover:text-ink-2'].join(' ')}>
                {SORT_LABEL[k]}
              </button>
            ))}
            <span className="h-3.5 w-px bg-line shrink-0" aria-hidden />
            <button onClick={() => setHideBack(!hideBack)} title="Hide backwardation (negative-carry) contracts"
              className={['font-body text-[11px] px-2 py-0.5 rounded-button border transition-colors', hideBack ? 'text-mint-deep border-mint-deep/50 bg-mint-tint' : 'text-muted border-line hover:text-ink-2'].join(' ')}>
              {hideBack ? '✓ ' : ''}Hide backwardation
            </button>
          </div>

          {/* Filter pills */}
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            <Pill active={!asset} onClick={() => setAsset('')}>All assets</Pill>
            {assets.map(a => <Pill key={a} active={asset === a} onClick={() => setAsset(asset === a ? '' : a)}>{a}</Pill>)}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            <Pill active={!exch} onClick={() => setExch('')}>All venues</Pill>
            {exchanges.map(x => <Pill key={x} active={exch === x} onClick={() => setExch(exch === x ? '' : x)}>{x}</Pill>)}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            <Pill active={!expiry} onClick={() => setExpiry('')}>All expiries</Pill>
            {expiries.map(e => <Pill key={e} active={expiry === e} onClick={() => setExpiry(expiry === e ? '' : e)} title={e}>{expiryLabel(e)}</Pill>)}
          </div>

          {/* Toggle filters + range inputs */}
          <div className="flex items-center gap-3 flex-wrap mb-3">
            <Pill active={execOnly} onClick={() => setExecOnly(!execOnly)} title="Executable-only: order-book depth ≥ $100k, USD-margined, net-of-fee > 0 (cashable). Applies to visible (paid) rows.">Executable-only</Pill>
            <Pill active={capMin} onClick={() => setCapMin(!capMin)} title="Capacity ≥ $100k (gated field — filters visible/paid rows)">Capacity ≥ $100k</Pill>
            <Pill active={usdOnly} onClick={() => setUsdOnly(!usdOnly)} title="USD-margined only — exclude coin-settled (inverse) contracts whose USD return drifts with spot">USD-margin only</Pill>
            <span className="h-3.5 w-px bg-line shrink-0" aria-hidden />
            <label className="flex items-center gap-1.5 whitespace-nowrap" title="Min net-of-fee annualized % (gated field — filters visible/paid rows)">
              <span className="font-body text-[10px] uppercase tracking-wide text-muted">Net/yr ≥</span>
              <input type="number" inputMode="decimal" min={0} step={0.5} value={minNet === 0 ? '' : minNet} placeholder="0"
                onChange={e => { const n = Number(e.target.value); setMinNet(Number.isFinite(n) && n > 0 ? n : 0); }}
                className="w-14 px-1.5 py-0.5 rounded-button border border-line bg-surface text-ink font-mono text-[11px] tabular-nums text-right focus:outline-none focus:border-mint-deep/50" />
              <span className="font-body text-[10px] text-muted">%</span>
            </label>
            <label className="flex items-center gap-1.5 whitespace-nowrap" title="Max days to expiry (public field)">
              <span className="font-body text-[10px] uppercase tracking-wide text-muted">Days ≤</span>
              <input type="number" inputMode="numeric" min={0} step={30} value={maxDays == null ? '' : maxDays} placeholder="all"
                onChange={e => { const n = Number(e.target.value); setMaxDays(Number.isFinite(n) && n > 0 ? Math.floor(n) : null); }}
                className="w-16 px-1.5 py-0.5 rounded-button border border-line bg-surface text-ink font-mono text-[11px] tabular-nums text-right focus:outline-none focus:border-mint-deep/50" />
            </label>
            <label className="flex items-center gap-1.5 whitespace-nowrap" title="Min 24h volume (public field)">
              <span className="font-body text-[10px] uppercase tracking-wide text-muted">Vol ≥ $</span>
              <input type="number" inputMode="numeric" min={0} step={100000} value={minVol === 0 ? '' : minVol} placeholder="0"
                onChange={e => { const n = Number(e.target.value); setMinVol(Number.isFinite(n) && n > 0 ? n : 0); }}
                className="w-20 px-1.5 py-0.5 rounded-button border border-line bg-surface text-ink font-mono text-[11px] tabular-nums text-right focus:outline-none focus:border-mint-deep/50" />
            </label>
            {filtersActive && <button onClick={resetFilters} className="font-body text-[10px] uppercase tracking-wide text-muted hover:text-coral-ink transition-colors">Reset</button>}
            <span className="ml-auto font-body text-[10px] text-muted tabular-nums">{rows.length} contract{rows.length !== 1 ? 's' : ''}{rows.length !== allOpps.length ? ` of ${allOpps.length}` : ''}</span>
          </div>

          {/* Column header */}
          <div className="grid grid-cols-[auto_1fr_auto_auto] gap-3 px-3 py-1.5 text-[9px] uppercase tracking-wider text-muted border-b border-line">
            <span className="w-8" aria-hidden />
            <span>Market</span>
            <span className="text-right">Net %/yr</span>
            <span className="w-3.5" aria-hidden />
          </div>

          {/* Contango rows */}
          <div className="rounded-b-lg overflow-hidden bg-surface border-x border-b border-line shadow-card mb-6">
            {rows.length === 0 ? (
              <p className="font-body text-[12px] text-muted text-center py-8">No contracts match these filters. <button onClick={resetFilters} className="text-mint-deep">Reset</button></p>
            ) : rows.map(c => (
              <ContractRow key={`${c.exchange}:${c.contract}`} c={c} isPaid={isPaid} open={openId === `${c.exchange}:${c.contract}`} onToggle={() => setOpenId(openId === `${c.exchange}:${c.contract}` ? null : `${c.exchange}:${c.contract}`)} />
            ))}
          </div>

          {/* Backwardation section (hidden by the toggle) */}
          {!hideBack && backRows.length > 0 && (
            <section className="mb-6">
              <div className="flex items-center gap-2 mb-2">
                <EdgeChip variant="signal" />
                <span className="font-body text-[12px] text-muted">Backwardation — futures below spot ({backRows.length}) · shown honestly, negative carry</span>
              </div>
              <div className="rounded-lg overflow-hidden bg-surface border border-line shadow-card">
                {backRows.map(c => (
                  <BackRow key={`${c.exchange}:${c.contract}`} c={c} isPaid={isPaid} open={openId === `${c.exchange}:${c.contract}`} onToggle={() => setOpenId(openId === `${c.exchange}:${c.contract}` ? null : `${c.exchange}:${c.contract}`)} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {data && allOpps.length === 0 && isRunning && (
        <div className="rounded-card shadow-card bg-surface px-6 py-12 text-center mb-8">
          <p className="font-display font-bold text-4xl text-ink mb-3">0</p>
          <p className="font-body text-base text-muted">No qualifying contango contracts right now — all filtered by the engine criteria.</p>
        </div>
      )}

      <div className="mb-6"><HonestyBlock /></div>

      <details className="mb-6 rounded-card shadow-card bg-surface px-5 py-4">
        <summary className="cursor-pointer font-body text-[12px] uppercase tracking-wide text-muted hover:text-ink-2 transition-colors select-none">Engine filters &amp; methodology</summary>
        <div className="mt-4 font-body text-[12px] text-muted leading-relaxed space-y-1.5 border-l-2 border-line pl-4">
          <p>1. daysToExpiry ≥ 20 days (too-near-expiry excluded)</p>
          <p>2. vol24h ≥ $500k → DEEP/OK; ≥ $100k → THIN (flagged); &lt; $100k → excluded</p>
          <p>3. netAnnualized = (basis − fees) × 365/days &gt; 0 (after fees, positive carry only)</p>
          <p>4. OKX symbols with XPERP excluded (extended perpetuals, not delivery futures)</p>
          <p>5. basis &lt; 0 → backwardation section, not opportunities</p>
          <p>6. COIN-M / OKX BTC-USD / ETH-USD labeled COIN-MARGINED; USD return drifts with spot</p>
          <p>7. capacity = min(vol×5%, OI×2%, $500k); BNB hard cap $50k</p>
        </div>
      </details>
    </div>
  );
}
