'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { ChevronRight, Lock } from 'lucide-react';
import { Redacted } from '@/app/components/ui/Redacted';

// ─────────────────────────────────────────────────────────────────────────────
// Paper book — trading-desk layout (dark). Account equity on top, Open/Closed
// tabs, filter chips, and expandable trade rows.
//
// HONEST-ENGINE (unchanged from the prior page — this is a LAYOUT redesign only):
//   • unknown = "—" (never zero-filled / never fabricated).
//   • realized (closed) and unrealized (open) are ALWAYS separate, never merged.
//   • equity = notional + realized + unrealized, arithmetic shown; THIN kept on
//     its own line, never inside the account value.
//   • N INDEPENDENT $1,000 tickets — never "one $1,000 book".
//   • sparkline = stored marks only, stepAfter, no interpolation.
//   • $ figures are server-nulled for the free tier (lib/paid-gating
//     REDACTION_MAP['paper-book']) → <Redacted> lock, never a blur over a real
//     value; counts + reason labels stay public. No API/number/tier change.
//   • No live-mark or exit *price* is stored for these spread instruments, so a
//     row's price cell shows the real ENTRY level (price for perp-spot/basis,
//     funding-rate spread for funding) — "—" where nothing real exists.
// ─────────────────────────────────────────────────────────────────────────────

// ── types (loose — the API is the source of truth) ──────────────────────────
interface Leg { venue?: string; side?: string; price?: number | null; settledRate?: number | null; intervalH?: number | null; [k: string]: unknown }
interface Mark { asOf?: string; netUsd?: number | null; unrealizedUsd?: number | null; cumFundingUsd?: number | null; currentBasisPct?: number | null; spot?: number | null; future?: number | null; realFundingPointsAdded?: number | null; trailingNetPerDay?: number | null; note?: string | null; [k: string]: unknown }
interface ExitInfo { asOf?: string | null; reason?: string | null; markPx?: number | null; trailingNetPerDay?: number | null; note?: string | null; [k: string]: unknown }
interface Position {
  id: string; category: string; label: string; status: string; metricKind: string;
  thin: boolean; value: number | null;
  exit: ExitInfo | null; realizedUsd: number | null;
  entry: (Record<string, any> & { legs?: Leg[] }) | null; lastMark: Mark | null; marks: Mark[];
  contractKey: string | null; fundingCursorT: number | null; cumFundingUsd: number | null;
}
interface Strategy {
  key: string; label: string; metric: string | null; chip: string;
  open: number; matured: number; closed: number; execOpen: number; execNotionalUsd: number | null;
  execPnlUsd: number | null; thinOpen: number; thinPnlUsd: number | null;
  realizedPnlUsd: number | null; positions: Position[];
}
interface Headline {
  executablePnlUsd: number | null; executablePnlHas: boolean; thinPnlUsd: number | null; thinOpen: number;
  ticketCount: number; ticketSizeUsd: number | null; totalNotionalUsd: number | null;
  openTicketCountAll: number; openNotionalUsdAll: number | null;
  closedRealizedUsd: number | null; closedCount: number; maturedCount: number;
}
interface PaperBook {
  ok: boolean; simulated: boolean; isPaid: boolean;
  meta: { entryAsOf: string | null; updatedAt: string | null; simDays: number | null; dayIndex: number; notionalUsd: number | null };
  headline: Headline;
  equityCurve: { asOf: string; netUsd: number | null }[];
  strategies: Strategy[];
  copy: { sleeveCount: number; openLegs: number; pnlUsd: number | null; sleeves: any[] };
  liquidity: any;
  signalOnly: { label: string; venues: string[]; note: string };
  excluded: { category: string; reason: string; value: string }[];
  annualizedCapNote: string;
}

// ── format helpers (honest: null → "—", never fabricated) ────────────────────
const fmtUsd = (n: number | null | undefined, dp = 2): string =>
  n == null || !isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(dp)}`;
const fmtUsdPlain = (n: number | null | undefined, dp = 2): string =>
  n == null || !isFinite(n) ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const fmtK = (n: number | null | undefined): string => {
  if (n == null || !isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
};
const fmtPct = (n: number | null | undefined, dp = 2): string =>
  n == null || !isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(dp)}%`;
const fmtWhen = (iso: string | null | undefined): string =>
  !iso ? '—' : new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtAge = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};
// dark P&L colors — calm loss (rose), not an alarm.
const pnl = (n: number | null | undefined): string =>
  n == null ? 'text-zinc-500' : n > 0 ? 'text-emerald-400' : n < 0 ? 'text-rose-400' : 'text-zinc-300';

// ── per-position honest accessors (real stored data only) ────────────────────
const isFunding = (p: Position) => p.category.includes('funding');
const isBasis   = (p: Position) => p.category === 'basis';
const legWithPrice = (p: Position): Leg | null => {
  const legs = p.entry?.legs ?? [];
  // prefer the perp/future (short) leg — the desk-relevant execution price
  return legs.find(l => /short/i.test(String(l.side)) && typeof l.price === 'number')
      ?? legs.find(l => typeof l.price === 'number') ?? null;
};
// the row's ENTRY level: real price where stored, else funding-rate spread, else "—".
function entryLevel(p: Position): { text: string; note: string } {
  const lp = legWithPrice(p);
  if (lp && typeof lp.price === 'number') {
    const px = lp.price;
    return { text: fmtUsdPlain(px, px < 10 ? 4 : 2), note: 'entry price' };
  }
  const legs = p.entry?.legs ?? [];
  const sh = legs.find(l => /short/i.test(String(l.side)));
  const lo = legs.find(l => /long/i.test(String(l.side)));
  if (sh && lo && typeof sh.settledRate === 'number' && typeof lo.settledRate === 'number') {
    const iv = sh.intervalH ?? lo.intervalH ?? 1;
    const spread = (sh.settledRate - lo.settledRate) * 100;
    return { text: `${spread >= 0 ? '+' : '−'}${Math.abs(spread).toFixed(3)}%/${iv}h`, note: 'entry funding spread' };
  }
  return { text: '—', note: 'not stored' };
}
// compact secondary line: side + venues (open) or close reason (closed).
function subLine(p: Position): string {
  if (p.status !== 'open') return p.exit?.reason ? `closed · ${p.exit.reason}` : 'closed';
  const legs = p.entry?.legs ?? [];
  if (legs.length >= 2) return legs.map(l => `${String(l.side ?? '').split(' ')[0] || '?'} ${l.venue ?? '—'}`).join(' / ');
  return p.metricKind || '—';
}
const coinOf = (p: Position): string => (p.entry?.coin as string) || p.label.split(/[ /]/)[0] || '—';

// ── tiny dark equity sparkline (stored marks only, stepAfter, no interpolation) ─
function Spark({ points, locked, height = 46 }: { points: { x: number; y: number | null }[]; locked: boolean; height?: number }) {
  const real = points.filter(p => p.y != null) as { x: number; y: number }[];
  if (locked || real.length < 2) {
    return (
      <div className="flex items-center justify-center rounded-md bg-[#0e1219] border border-[#1c2230]" style={{ height }}>
        {locked ? <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500"><Lock className="w-3 h-3" /> locked</span>
                : <span className="text-[10px] text-zinc-600">not enough stored marks</span>}
      </div>
    );
  }
  const W = 320, H = height, pad = 3;
  const xs = real.map(p => p.x), ys = real.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = (x: number) => pad + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * pad);
  const sy = (y: number) => pad + (1 - (y - y0) / (y1 - y0 || 1)) * (H - 2 * pad);
  // stepAfter: hold each mark's value until the next stored mark (no interpolation).
  let d = `M ${sx(real[0].x)} ${sy(real[0].y)}`;
  for (let i = 1; i < real.length; i++) { d += ` L ${sx(real[i].x)} ${sy(real[i - 1].y)} L ${sx(real[i].x)} ${sy(real[i].y)}`; }
  const last = real[real.length - 1].y;
  const stroke = last > 0 ? '#34d399' : last < 0 ? '#fb7185' : '#a1a1aa';
  const zeroY = y0 < 0 && y1 > 0 ? sy(0) : null;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }} className="rounded-md bg-[#0e1219] border border-[#1c2230]">
      {zeroY != null && <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke="#2a3140" strokeWidth={0.75} strokeDasharray="3 3" />}
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

// ── account equity block ─────────────────────────────────────────────────────
function EquityBlock({ h, curve, isPaid, updatedAt }: { h: Headline; curve: PaperBook['equityCurve']; isPaid: boolean; updatedAt: string | null }) {
  const notional = h.totalNotionalUsd, realized = h.closedRealizedUsd, unreal = h.executablePnlUsd;
  const equity = (notional != null && realized != null && unreal != null) ? notional + realized + unreal : null;
  const eqPct = (equity != null && notional) ? ((equity - notional) / notional) * 100 : null;
  const pts = useMemo(() => curve.map(p => ({ x: new Date(p.asOf).getTime(), y: p.netUsd })), [curve]);
  const locked = !isPaid || curve.every(p => p.netUsd == null);
  return (
    <div className="rounded-xl bg-[#12161f] border border-[#1f2530] px-5 py-5 mb-3">
      <div className="flex items-start justify-between gap-3 mb-1">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">Account equity · paper</span>
        <span className="text-[10px] text-zinc-600">updated {fmtAge(updatedAt)}</span>
      </div>
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className={`font-bold tracking-tight tabular-nums ${equity == null ? 'text-zinc-500' : 'text-zinc-50'}`} style={{ fontSize: 38 }}>
          <Redacted value={equity} isPaid={isPaid}>{v => fmtUsdPlain(v as number, 2)}</Redacted>
        </span>
        {eqPct != null && isPaid && (
          <span className={`text-[14px] font-semibold ${pnl(eqPct)}`}>{eqPct >= 0 ? '▲' : '▼'} {Math.abs(eqPct).toFixed(2)}%</span>
        )}
      </div>
      <p className="text-[11px] text-zinc-500 mt-1.5 tabular-nums" title="equity = notional + realized + unrealized">
        = notional {fmtK(notional)} {isPaid ? <>+ realized {fmtUsd(realized)} + unrealized {fmtUsd(unreal)}</> : <>+ realized <Lock className="inline w-2.5 h-2.5" /> + unrealized <Lock className="inline w-2.5 h-2.5" /></>}
      </p>
      <p className="text-[10.5px] text-zinc-600 mt-0.5">~{h.ticketCount} independent ${h.ticketSizeUsd?.toLocaleString()} tickets · <span className="text-zinc-500">not one ${h.ticketSizeUsd?.toLocaleString()} book</span></p>

      {/* three sub-boxes — realized & unrealized ALWAYS separate */}
      <div className="grid grid-cols-3 gap-2 mt-4">
        <div className="rounded-lg bg-[#0e1219] border border-[#1c2230] px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Notional</p>
          <p className="text-[15px] font-semibold text-zinc-200 tabular-nums">{fmtK(notional)}</p>
          <p className="text-[9px] text-zinc-600">{h.ticketCount} tickets</p>
        </div>
        <div className="rounded-lg bg-[#0e1219] border border-[#1c2230] px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Realized · closed</p>
          <p className={`text-[15px] font-semibold tabular-nums ${pnl(realized)}`}><Redacted value={realized} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted></p>
          <p className="text-[9px] text-zinc-600">{h.closedCount} closed</p>
        </div>
        <div className="rounded-lg bg-[#0e1219] border border-[#1c2230] px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Unrealized · open</p>
          <p className={`text-[15px] font-semibold tabular-nums ${pnl(unreal)}`}><Redacted value={unreal} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted></p>
          <p className="text-[9px] text-zinc-600">{h.ticketCount} open exec</p>
        </div>
      </div>
      {h.thinOpen ? (
        <p className="text-[10px] text-zinc-600 mt-2">THIN <Redacted value={h.thinPnlUsd} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted> ({h.thinOpen} not-exec-at-size) — shown separately, never inside equity.</p>
      ) : null}

      {/* equity sparkline */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">Equity · stored marks</span>
          <span className="text-[9.5px] text-zinc-600">stepped · no interpolation</span>
        </div>
        <Spark points={pts} locked={locked} />
      </div>
    </div>
  );
}

// ── expandable trade row ─────────────────────────────────────────────────────
function DetailCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md bg-[#0e1219] border border-[#1c2230] px-2.5 py-2">
      <p className="text-[9px] uppercase tracking-wide text-zinc-500 mb-0.5">{label}</p>
      <p className="text-[12px] text-zinc-200 tabular-nums leading-tight">{children}</p>
    </div>
  );
}

function TradeRow({ p, isPaid, open, onToggle }: { p: Position; isPaid: boolean; open: boolean; onToggle: () => void }) {
  const closed = p.status !== 'open';
  const rowPnl = closed ? p.realizedUsd : p.value;
  const lvl = entryLevel(p);
  const dash = <span className="text-zinc-600">—</span>;
  const lm = p.lastMark ?? {};
  const legs = p.entry?.legs ?? [];
  return (
    <div className="border-b border-[#161b25]">
      <button onClick={onToggle} className="w-full grid grid-cols-[1fr_auto_auto] items-center gap-3 px-3 py-2.5 text-left hover:bg-[#151a24] transition-colors">
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="text-[12.5px] text-zinc-100 truncate">{p.label}</span>
            {p.thin && <span className="text-[8.5px] uppercase tracking-wide text-amber-400/90 border border-amber-400/30 rounded px-1 shrink-0">thin</span>}
          </span>
          <span className="text-[10px] text-zinc-500 truncate block">{subLine(p)}</span>
        </span>
        <span className="text-right tabular-nums shrink-0">
          <span className="block text-[12px] text-zinc-300">{lvl.text}</span>
          <span className="block text-[8.5px] uppercase tracking-wide text-zinc-600">{closed ? 'exit·—' : 'entry'}</span>
        </span>
        <span className="text-right tabular-nums shrink-0 w-[86px] flex items-center justify-end gap-1">
          <span>
            <span className={`block text-[12.5px] font-semibold ${pnl(rowPnl)}`}><Redacted value={rowPnl} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted></span>
            <span className="block text-[8.5px] uppercase tracking-wide text-zinc-600">{closed ? 'realized' : 'unreal.'}</span>
          </span>
          <ChevronRight className={`w-3.5 h-3.5 text-zinc-600 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-0.5 bg-[#0c0f16]">
          {/* legs */}
          <div className="grid grid-cols-2 gap-1.5 mb-1.5">
            {legs.map((lg, i) => (
              <DetailCell key={i} label={String(lg.side ?? `leg ${i + 1}`)}>
                {lg.venue ?? dash}
                {typeof lg.price === 'number' && <span className="text-zinc-500"> · {fmtUsdPlain(lg.price, lg.price < 10 ? 4 : 2)}</span>}
                {typeof lg.settledRate === 'number' && <span className="text-zinc-500"> · {(lg.settledRate * 100).toFixed(4)}%/{lg.intervalH ?? 1}h</span>}
              </DetailCell>
            ))}
          </div>
          {/* entry + tail (open vs closed differ) */}
          <div className="grid grid-cols-2 gap-1.5">
            <DetailCell label="Entry time">{fmtWhen(p.entry?.asOf)}</DetailCell>
            <DetailCell label="Entry level">{lvl.text}{lvl.note !== 'entry price' && <span className="text-zinc-600"> · {lvl.note}</span>}</DetailCell>
            <DetailCell label="Size (ticket)">{p.entry?.notionalUsd != null ? fmtUsdPlain(p.entry.notionalUsd, 0) : dash}</DetailCell>
            <DetailCell label="Metric">{p.metricKind || dash}</DetailCell>

            {!closed ? (
              <>
                <DetailCell label="Mark @">{fmtWhen(lm.asOf)}</DetailCell>
                <DetailCell label="Live mark">
                  {isBasis(p)
                    ? (lm.future != null ? <>fut <Redacted value={lm.future} isPaid={isPaid}>{v => fmtUsdPlain(v as number, 2)}</Redacted></> : dash)
                    : (<>cum funding <Redacted value={p.cumFundingUsd} isPaid={isPaid}>{v => fmtUsdPlain(v as number, 2)}</Redacted></>)}
                </DetailCell>
                <DetailCell label="Unrealized P&L"><span className={pnl(p.value)}><Redacted value={p.value} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted></span></DetailCell>
                <DetailCell label="Realized P&L"><span className="text-zinc-600">— (open)</span></DetailCell>
              </>
            ) : (
              <>
                <DetailCell label="Exit time">{fmtWhen(p.exit?.asOf)}</DetailCell>
                <DetailCell label="Exit price">{dash}<span className="text-zinc-600"> · not stored</span></DetailCell>
                <DetailCell label="Close reason">{p.exit?.reason || dash}</DetailCell>
                <DetailCell label="Realized P&L"><span className={pnl(p.realizedUsd)}><Redacted value={p.realizedUsd} isPaid={isPaid}>{v => fmtUsd(v as number)}</Redacted></span></DetailCell>
              </>
            )}
          </div>
          {!isPaid && <p className="text-[9px] text-zinc-600 mt-1.5">Locked $ figures are null server-side on the free tier — never blurred over a real value.</p>}
        </div>
      )}
    </div>
  );
}

// ── filter chips ─────────────────────────────────────────────────────────────
type FilterKey = 'all' | 'winners' | 'losers' | 'funding' | 'basis';
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'winners', label: 'Winners' }, { key: 'losers', label: 'Losers' },
  { key: 'funding', label: 'Funding' }, { key: 'basis', label: 'Basis' },
];
function matchesFilter(p: Position, f: FilterKey): boolean {
  const v = p.status === 'open' ? p.value : p.realizedUsd;
  switch (f) {
    case 'all':     return true;
    case 'winners': return v != null && v > 0;   // free tier: v null → excluded (can't see P&L)
    case 'losers':  return v != null && v < 0;
    case 'funding': return isFunding(p);
    case 'basis':   return isBasis(p);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// page
// ══════════════════════════════════════════════════════════════════════════════
export default function PaperBookPage() {
  const [data, setData] = useState<PaperBook | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/paper-book', { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'paper book not initialized'); return; }
      setData(j); setErr(null);
    } catch (e: any) { setErr(e?.message || 'failed to load'); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const isPaid = data?.isPaid ?? false;
  const h = data?.headline;
  const positions = useMemo(() => (data?.strategies ?? []).flatMap(s => s.positions), [data]);
  const openList = useMemo(() => positions.filter(p => p.status === 'open'), [positions]);
  const closedList = useMemo(() => positions.filter(p => p.status !== 'open'), [positions]);
  const list = tab === 'open' ? openList : closedList;
  const filtered = useMemo(() => list.filter(p => matchesFilter(p, filter)), [list, filter]);
  const CAP = 100;
  const shown = filtered.slice(0, CAP);

  return (
    <main className="min-h-screen bg-[#0a0d12] text-zinc-200">
      <div className="max-w-[480px] mx-auto px-4 pb-24 pt-5">
        {/* header */}
        <div className="flex items-center justify-between mb-1">
          <h1 className="font-bold text-zinc-50 text-[21px] tracking-tight">Paper desk</h1>
          <span className="text-[9px] uppercase tracking-wider text-violet-300 border border-violet-400/30 rounded px-1.5 py-0.5">Simulated</span>
        </div>
        <p className="text-[11.5px] text-zinc-500 mb-4">
          {data ? `Day ${data.meta.dayIndex}/${data.meta.simDays ?? 7} · forward paper sim · marked from real data` : 'Loading…'}
        </p>

        {err && (
          <div className="rounded-xl bg-[#12161f] border border-[#1f2530] px-5 py-6 text-center">
            <p className="text-[13px] text-zinc-300">{err}</p>
            <p className="text-[11px] text-zinc-500 mt-1">The paper book freezes its first snapshot on the next agent32 cycle.</p>
          </div>
        )}

        {data && h && (
          <>
            <EquityBlock h={h} curve={data.equityCurve} isPaid={isPaid} updatedAt={data.meta.updatedAt} />

            {/* tabs */}
            <div className="flex gap-1 p-1 rounded-lg bg-[#12161f] border border-[#1f2530] mb-2">
              {([['open', `Open · ${openList.length}`], ['closed', `Closed · ${h.closedCount}`]] as const).map(([k, lbl]) => (
                <button key={k} onClick={() => { setTab(k); setExpanded(null); }}
                  className={`flex-1 text-[12px] font-medium py-1.5 rounded-md transition-colors ${tab === k ? 'bg-[#232b3a] text-zinc-50' : 'text-zinc-500 hover:text-zinc-300'}`}>
                  {lbl}
                </button>
              ))}
            </div>

            {/* filter chips */}
            <div className="flex gap-1.5 mb-2 overflow-x-auto pb-0.5">
              {FILTERS.map(f => (
                <button key={f.key} onClick={() => setFilter(f.key)}
                  className={`text-[11px] px-2.5 py-1 rounded-full border whitespace-nowrap transition-colors ${filter === f.key ? 'bg-violet-500/20 border-violet-400/40 text-violet-200' : 'bg-[#12161f] border-[#1f2530] text-zinc-400 hover:text-zinc-200'}`}>
                  {f.label}
                </button>
              ))}
              <span className="ml-auto text-[10px] text-zinc-600 self-center whitespace-nowrap pl-2">{filtered.length} shown</span>
            </div>

            {/* column header */}
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-1.5 text-[9px] uppercase tracking-wider text-zinc-600 border-b border-[#1f2530]">
              <span>Market</span>
              <span className="text-right">{tab === 'open' ? 'Entry' : 'Exit'}</span>
              <span className="text-right w-[86px] pr-5">P&L</span>
            </div>

            {/* rows */}
            <div className="rounded-b-lg overflow-hidden bg-[#0f131b] border-x border-b border-[#1f2530]">
              {shown.length === 0 ? (
                <p className="text-[11.5px] text-zinc-500 text-center py-8">
                  {filter === 'winners' || filter === 'losers'
                    ? (isPaid ? `No ${filter} in ${tab} trades.` : `${filter[0].toUpperCase()}${filter.slice(1)} needs P&L — locked on the free tier.`)
                    : `No ${tab} trades match.`}
                </p>
              ) : shown.map(p => (
                <TradeRow key={p.id} p={p} isPaid={isPaid} open={expanded === p.id} onToggle={() => setExpanded(expanded === p.id ? null : p.id)} />
              ))}
              {filtered.length > CAP && (
                <p className="text-[10px] text-zinc-600 text-center py-2">+{filtered.length - CAP} more (showing first {CAP})</p>
              )}
            </div>

            {/* footer honesty */}
            <p className="text-[9.5px] text-zinc-600 mt-4 leading-snug text-center">
              Real stored marks only · realized (closed) and unrealized (open) never merged · THIN &amp; signal-only never in equity · missing = "—", never fabricated.
              {!isPaid && <> Derived $ is null on the free tier — <a href="/dashboard/upgrade" className="text-violet-300">upgrade →</a></>}
            </p>
          </>
        )}
      </div>
    </main>
  );
}
