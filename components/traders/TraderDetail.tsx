'use client';

// Per-trader detail view — reads agent30's live feed via /api/traders/feed/[addr]
// and renders an honest, always-fresh reconstruction of a wallet's Polymarket
// activity. HONEST-ENGINE: every number is a real fill / real Data-API read;
// unrealized P&L is marked to current mid and LABELLED as such; resolved settles
// 100¢/0¢ with no exit price; missing inputs render "—", never invented. The
// "as of HH:MM:SS" is the true feed updatedAt; the health chip is the real WS state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, Activity, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { Redacted } from '@/app/components/ui/Redacted';
import { PlatformLink } from '@/app/components/ui/PlatformLink';
import { polymarketProfileUrl, polymarketMarketUrl, polymarketOutcomeUrl } from '@/lib/platform-links';
import {
  fmtPnl, fmtWallet, fmtRelShort, fmtSince, fmtPct1, fmtSize, pnlColor, catText,
} from './format';

// ── Response types (mirror /api/traders/feed/[address]) ──────────────────────
interface RawFill {
  txHash: string | null; asset: string; conditionId: string | null; side: string | null;
  price: number | null; size: number; timestamp: number; title: string | null;
  slug: string | null; eventSlug: string | null; outcome: string | null; outcomeIndex: number | null;
}
interface Position {
  key: string; market: string | null; slug: string | null; eventSlug: string | null;
  conditionId: string | null; asset: string; outcome: string | null;
  status: 'open' | 'closed' | 'resolved' | 'settled';
  shares: number | null; avgEntry: number | null; close: number | null; closeLabel: string;
  costBasis: number | null; proceeds: number | null; pnl: number | null; pnlLabel: string;
  realized: boolean; roiPct: number | null; heldDays: number | null; nFills: number;
  incompleteBasis: boolean; category: string; lastActivityTs: number | null;
}
interface Summary {
  realizedPnl: number | null; unrealizedPnl: number | null; costBasisOpen: number | null;
  openCount: number; closedCount: number; resolvedCount: number; settledCount: number;
  winRateRealized: number | null; realizedTrades: number;
}
interface FeedResp {
  ok: boolean; address: string; error?: string; isPaid?: boolean;
  updatedAt: string | null; feedHealthy: boolean; wsConnected: boolean; resyncing: boolean;
  lastWsMsgAt: string | null; lastFullResyncAt: string | null; stale: boolean;
  since: number | null; lastTradeTs: number | null; fillsCount: number; fillsCapped: boolean;
  fillsPerWallet: number | null;
  summary: Summary; positions: Position[];
  equityCurve: { t: number; cum: number }[] | null;
  categoryPnl: { category: string; realizedPnl: number; winRate: number | null; n: number }[] | null;
  fills: RawFill[];
}

const POLL_MS = 15_000;

function hhmmss(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour12: false });
}

function positionUrl(p: Position): string | null {
  return polymarketOutcomeUrl(p.eventSlug, p.slug) || polymarketMarketUrl(p.slug) || polymarketMarketUrl(p.eventSlug);
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function TraderDetail({ address }: { address: string }) {
  const [data, setData]   = useState<FeedResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter]   = useState<'all' | 'open' | 'closed' | 'resolved' | 'settled'>('all');
  const [tick, setTick] = useState(0);   // forces relative-time re-render

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/traders/feed/${address}`, { cache: 'no-store' });
      const d: FeedResp = await r.json();
      if (!r.ok || !d.ok) { setError(d.error || 'Feed unavailable.'); setData(d?.updatedAt ? d : null); }
      else { setData(d); setError(null); }
    } catch (e: any) {
      setError(e?.message || 'Network error.');
    } finally { setLoading(false); }
  }, [address]);

  useEffect(() => { load(); const id = setInterval(load, POLL_MS); return () => clearInterval(id); }, [load]);
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 30_000); return () => clearInterval(id); }, []);

  const isPaid = !!data?.isPaid;
  const positions = data?.positions ?? [];
  const shown = useMemo(
    () => positions.filter(p => filter === 'all' ? true : p.status === filter),
    [positions, filter]);

  const healthState = !data ? 'loading'
    : data.resyncing ? 'resyncing'
    : data.feedHealthy ? 'healthy'
    : 'unhealthy';

  return (
    <div className="min-h-screen bg-bg text-ink">
      <div className="mx-auto max-w-4xl px-4 py-6">

        {/* back */}
        <Link href="/dashboard/traders"
          className="inline-flex items-center gap-1.5 text-muted hover:text-ink transition-colors font-body text-[13px] mb-4">
          <ArrowLeft size={15} /> All traders
        </Link>

        {/* header */}
        <Header address={address} data={data} healthState={healthState} tick={tick} />

        {loading && !data && (
          <div className="mt-8 text-center text-muted font-body text-sm">Loading trader feed…</div>
        )}

        {error && !data && (
          <div className="mt-6 rounded-xl border border-line bg-surface p-5">
            <div className="flex items-start gap-2 text-muted font-body text-sm">
              <AlertTriangle size={16} className="mt-0.5 text-warn shrink-0" />
              <div>{error}</div>
            </div>
          </div>
        )}

        {data && data.ok && (
          <>
            <SummaryStats s={data.summary} isPaid={isPaid} />
            <EquityCurve curve={data.equityCurve} isPaid={isPaid} />
            <CategoryChips cats={data.categoryPnl} isPaid={isPaid} />

            {/* filters */}
            <div className="mt-6 flex items-center gap-1.5 flex-wrap">
              {(['all', 'open', 'closed', 'resolved', 'settled'] as const).map(f => {
                const n = f === 'all' ? positions.length
                  : f === 'open' ? data.summary.openCount
                  : f === 'closed' ? data.summary.closedCount
                  : f === 'resolved' ? data.summary.resolvedCount
                  : data.summary.settledCount;
                if (f === 'settled' && data.summary.settledCount === 0) return null;
                return (
                  <button key={f} onClick={() => setFilter(f)}
                    className={`font-body text-[12px] px-2.5 py-1 rounded-md border transition-colors capitalize ${
                      filter === f ? 'border-mint-deep/50 bg-mint-tint text-mint-deep font-semibold'
                                   : 'border-line text-muted hover:text-ink'}`}>
                    {f} <span className="tabular-nums opacity-70">{n}</span>
                  </button>
                );
              })}
            </div>

            {/* positions */}
            <div className="mt-3 rounded-xl border border-line bg-surface overflow-hidden">
              {shown.length === 0 ? (
                <div className="px-4 py-8 text-center text-muted font-body text-sm">
                  No {filter === 'all' ? '' : filter + ' '}positions reconstructable from the tracked fills.
                </div>
              ) : shown.map(p => (
                <PositionRow key={p.key} p={p} fills={data.fills} isPaid={isPaid} />
              ))}
            </div>

            <HonestNote data={data} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────
function Header({ address, data, healthState, tick }: {
  address: string; data: FeedResp | null; healthState: string; tick: number;
}) {
  const profUrl = polymarketProfileUrl(address);
  void tick; // relative times recompute on tick
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="font-display font-bold text-xl text-ink truncate">{fmtWallet(address)}</h1>
          <div className="mt-1 flex items-center gap-2 flex-wrap font-body text-[12px] text-muted">
            <span className="font-mono">{address}</span>
            {profUrl && <PlatformLink href={profUrl} label="Polymarket profile" compact />}
          </div>
        </div>
        <HealthChip state={healthState} />
      </div>

      <div className="mt-4 flex items-center gap-x-5 gap-y-1 flex-wrap font-body text-[12px] text-muted">
        <span>since <b className="text-ink-2 font-semibold">{fmtSince(data?.since)}</b></span>
        <span>last trade <b className="text-ink-2 font-semibold">{fmtRelShort(data?.lastTradeTs)}</b></span>
        <span>fills tracked <b className="text-ink-2 font-semibold tabular-nums">{data?.fillsCount ?? '—'}</b>
          {data?.fillsCapped && <span className="text-faint"> (last {data.fillsPerWallet}; older on Polymarket)</span>}</span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          <span className="text-faint">as of</span>
          <b className="text-ink-2 font-mono tabular-nums">{hhmmss(data?.updatedAt ?? null)}</b>
        </span>
      </div>
    </div>
  );
}

function HealthChip({ state }: { state: string }) {
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    healthy:    { label: 'live feed healthy', cls: 'border-mint-deep/40 text-mint-deep bg-mint-tint', icon: <Activity size={12} /> },
    resyncing:  { label: 're-syncing…',       cls: 'border-gold/40 text-gold bg-gold-tint',           icon: <RefreshCw size={12} className="animate-spin" /> },
    unhealthy:  { label: 'feed reconnecting', cls: 'border-coral/40 text-coral-ink bg-coral-tint',    icon: <AlertTriangle size={12} /> },
    loading:    { label: 'connecting…',       cls: 'border-line text-muted bg-bg-soft',               icon: <RefreshCw size={12} className="animate-spin" /> },
  };
  const m = map[state] || map.loading;
  return (
    <span className={`inline-flex items-center gap-1.5 font-body text-[11px] font-medium px-2 py-1 rounded-md border ${m.cls}`}>
      {m.icon}{m.label}
    </span>
  );
}

// ── Summary stats ─────────────────────────────────────────────────────────────
function SummaryStats({ s, isPaid }: { s: Summary; isPaid: boolean }) {
  return (
    <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
      <StatCard label="Realized P&L" hint="closed sells + settlements">
        <span className={`font-display font-bold text-lg ${pnlColor(s.realizedPnl)}`}>
          <Redacted value={s.realizedPnl} isPaid={isPaid}>{v => fmtPnl(v)}</Redacted>
        </span>
      </StatCard>
      <StatCard label="Unrealized P&L" hint="open · mark-to-mid">
        <span className={`font-display font-bold text-lg ${pnlColor(s.unrealizedPnl)}`}>
          <Redacted value={s.unrealizedPnl} isPaid={isPaid}>{v => fmtPnl(v)}</Redacted>
        </span>
      </StatCard>
      <StatCard label="Win rate" hint={`${s.realizedTrades} realized`}>
        <span className="font-display font-bold text-lg text-ink tabular-nums">
          {s.winRateRealized != null ? `${s.winRateRealized.toFixed(0)}%` : <span className="text-muted">—</span>}
        </span>
      </StatCard>
      <StatCard label="Positions" hint={`${s.openCount} open · ${s.resolvedCount} resolved · ${s.closedCount} closed${s.settledCount ? ` · ${s.settledCount} settled` : ''}`}>
        <span className="font-display font-bold text-lg text-ink tabular-nums">
          {s.openCount + s.resolvedCount + s.closedCount + s.settledCount}
        </span>
      </StatCard>
    </div>
  );
}
function StatCard({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3.5 py-3">
      <div className="font-body text-[10px] uppercase tracking-wide text-muted/80">{label}</div>
      <div className="mt-1">{children}</div>
      {hint && <div className="mt-0.5 font-body text-[10px] text-faint truncate">{hint}</div>}
    </div>
  );
}

// ── Equity curve (cumulative realized P&L) ────────────────────────────────────
function EquityCurve({ curve, isPaid }: { curve: FeedResp['equityCurve']; isPaid: boolean }) {
  if (curve === null) {
    // redacted (free tier) — honest locked teaser, not a fabricated chart
    if (isPaid) return null;
    return (
      <div className="mt-5 rounded-xl border border-line bg-surface p-4">
        <div className="font-body text-[11px] uppercase tracking-wide text-muted/80 mb-1">Realized P&amp;L curve</div>
        <Redacted value={null} isPaid={false}>{() => null}</Redacted>
      </div>
    );
  }
  if (!curve || curve.length < 2) return null; // honest: not reconstructable → omit

  const W = 640, H = 120, PAD = 6;
  const xs = curve.map(p => p.t), ys = curve.map(p => p.cum);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys), maxY = Math.max(0, ...ys);
  const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
  const px = (t: number) => PAD + ((t - minX) / spanX) * (W - 2 * PAD);
  const py = (v: number) => PAD + (1 - (v - minY) / spanY) * (H - 2 * PAD);
  const d = curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.t).toFixed(1)},${py(p.cum).toFixed(1)}`).join(' ');
  const last = ys[ys.length - 1];
  const zeroY = py(0);

  return (
    <div className="mt-5 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="font-body text-[11px] uppercase tracking-wide text-muted/80">Realized P&amp;L curve</div>
        <div className={`font-mono text-[12px] font-semibold ${pnlColor(last)}`}>{fmtPnl(last)}</div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full h-[120px]" preserveAspectRatio="none">
        <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="var(--er-line, #E3ECE7)" strokeWidth="1" strokeDasharray="3 3" />
        <path d={d} fill="none" stroke={last >= 0 ? 'var(--er-mint-deep, #0A9D6B)' : 'var(--er-coral-ink, #D5552F)'} strokeWidth="1.75" />
      </svg>
      <div className="mt-1 font-body text-[10px] text-faint">
        Cumulative realized P&amp;L from exit sells + settlements ({curve.length} events). Open positions are excluded (see unrealized above).
      </div>
    </div>
  );
}

// ── Category realized P&L ─────────────────────────────────────────────────────
function CategoryChips({ cats, isPaid }: { cats: FeedResp['categoryPnl']; isPaid: boolean }) {
  if (cats === null) return null;      // redacted → the summary/positions carry the teaser
  if (!cats || cats.length === 0) return null;
  void isPaid;
  return (
    <div className="mt-4 flex items-center gap-2 flex-wrap">
      {cats.map(c => (
        <div key={c.category} className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5">
          <span className={`font-body text-[11px] font-semibold ${catText(c.category)}`}>{c.category}</span>
          <span className={`font-mono text-[11px] ${pnlColor(c.realizedPnl)}`}>{fmtPnl(c.realizedPnl)}</span>
          {c.winRate != null && <span className="font-body text-[10px] text-faint tabular-nums">{c.winRate.toFixed(0)}% · {c.n}</span>}
        </div>
      ))}
    </div>
  );
}

// ── Position row (expandable) ─────────────────────────────────────────────────
const STATUS_STYLE: Record<Position['status'], string> = {
  open:     'border-brand/40 text-accent bg-brand/10',
  closed:   'border-line text-muted bg-bg-soft',
  resolved: 'border-mint-deep/40 text-mint-deep bg-mint-tint',
  settled:  'border-gold/40 text-gold bg-gold-tint',
};

function PositionRow({ p, fills, isPaid }: { p: Position; fills: RawFill[]; isPaid: boolean }) {
  const [open, setOpen] = useState(false);
  const url = positionUrl(p);
  const posFills = useMemo(() => fills.filter(f => f.asset === p.asset).sort((a, b) => b.timestamp - a.timestamp), [fills, p.asset]);

  return (
    <div className="border-b border-line last:border-b-0">
      <div onClick={() => setOpen(o => !o)}
        className="flex items-center gap-3 px-4 py-3 hover:bg-bg-soft/40 cursor-pointer transition-colors">
        <button className="text-muted shrink-0" aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-body font-semibold text-[13px] text-ink truncate max-w-[280px]">{p.market || '—'}</span>
            <span className={`font-body text-[9px] font-medium px-1.5 py-[1px] rounded uppercase tracking-wide border ${STATUS_STYLE[p.status]}`}>{p.status}</span>
            {p.outcome && <span className={`font-body text-[10px] px-1.5 py-[1px] rounded bg-bg-soft ${catText(p.category)}`}>{p.outcome}</span>}
          </div>
          <div className="mt-1 flex items-center gap-x-3 gap-y-0.5 flex-wrap font-body text-[10.5px] text-muted">
            <span>avg <b className="font-mono text-ink-2"><Redacted value={p.avgEntry} isPaid={isPaid}>{v => v.toFixed(3)}</Redacted></b> · {p.nFills} {p.nFills === 1 ? 'fill' : 'fills'}</span>
            <span>{p.closeLabel} <b className="font-mono text-ink-2"><Redacted value={p.close} isPaid={isPaid}>{v => v.toFixed(3)}</Redacted></b></span>
            <span>{fmtSize(p.shares)} sh</span>
            {p.heldDays != null && <span>{p.heldDays < 1 ? '<1d' : `${p.heldDays.toFixed(0)}d`} held</span>}
          </div>
        </div>

        <div className="text-right shrink-0 w-[110px]">
          <div className={`font-display font-bold text-[15px] tabular-nums ${pnlColor(p.pnl)}`}>
            <Redacted value={p.pnl} isPaid={isPaid}>{v => fmtPnl(v)}</Redacted>
          </div>
          <div className="font-body text-[9px] text-faint truncate" title={p.pnlLabel}>
            {p.roiPct != null ? <span className="font-mono">{fmtPct1(p.roiPct)}</span> : ''} {p.status === 'settled' ? 'settled · P&L n/a' : p.realized ? 'realized' : 'unrealized'}
          </div>
        </div>
      </div>

      {open && <PositionExpand p={p} posFills={posFills} url={url} isPaid={isPaid} />}
    </div>
  );
}

// ── Expanded position: lazy price history + fills marked + fill table ─────────
function PositionExpand({ p, posFills, url, isPaid }: {
  p: Position; posFills: RawFill[]; url: string | null; isPaid: boolean;
}) {
  const [hist, setHist] = useState<{ t: number; p: number }[] | null>(null);
  const [histState, setHistState] = useState<'loading' | 'ok' | 'none'>('loading');
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    (async () => {
      try {
        const times = posFills.map(f => f.timestamp);
        const startTs = times.length ? Math.min(...times) - 3600 : '';
        const endTs   = times.length ? Math.max(...times) + 3600 : '';
        const qs = new URLSearchParams({ token: p.asset, fidelity: '5' });
        if (startTs) qs.set('startTs', String(startTs));
        if (endTs)   qs.set('endTs', String(endTs));
        const r = await fetch(`/api/traders/price-history?${qs.toString()}`, { cache: 'no-store' });
        const d = await r.json();
        if (d.ok && Array.isArray(d.history) && d.history.length >= 2) { setHist(d.history); setHistState('ok'); }
        else setHistState('none');
      } catch { setHistState('none'); }
    })();
  }, [p.asset, posFills]);

  return (
    <div className="px-4 pb-4 pt-1 bg-bg-soft/30">
      {/* chart or honest degrade */}
      {histState === 'loading' && <div className="h-[130px] flex items-center justify-center text-faint font-body text-[11px]">loading price history…</div>}
      {histState === 'ok' && hist && <FillChart hist={hist} fills={posFills} isPaid={isPaid} />}
      {histState === 'none' && (
        <div className="rounded-lg border border-line bg-surface px-3 py-2 font-body text-[11px] text-muted">
          No free price history for this token — showing fills only (honest degrade; no chart fabricated).
        </div>
      )}

      {/* cost basis / proceeds / best fill */}
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 font-body text-[11px]">
        <MiniStat label="Cost basis"><Redacted value={p.costBasis} isPaid={isPaid}>{v => `$${v.toFixed(2)}`}</Redacted></MiniStat>
        <MiniStat label={p.status === 'open' ? 'Mark value' : 'Proceeds'}>
          <Redacted value={p.status === 'open' ? p.costBasis != null && p.pnl != null ? p.costBasis + p.pnl : null : p.proceeds} isPaid={isPaid}>{v => `$${v.toFixed(2)}`}</Redacted>
        </MiniStat>
        <MiniStat label="P&L"><span className={pnlColor(p.pnl)}><Redacted value={p.pnl} isPaid={isPaid}>{v => fmtPnl(v)}</Redacted></span></MiniStat>
        <MiniStat label="ROI">{p.roiPct != null ? <span className={pnlColor(p.roiPct)}>{fmtPct1(p.roiPct)}</span> : '—'}</MiniStat>
      </div>
      <div className="mt-1 font-body text-[10px] text-faint">
        {p.pnlLabel}{p.incompleteBasis && ' — cost basis may be incomplete (fill window capped); P&L withheld rather than shown wrong.'}
      </div>

      {/* fill table */}
      <div className="mt-3 rounded-lg border border-line bg-surface overflow-x-auto">
        <table className="w-full font-mono text-[11px]">
          <thead>
            <tr className="text-muted/80 border-b border-line">
              <th className="text-left font-body font-medium px-3 py-1.5">side</th>
              <th className="text-right font-body font-medium px-3 py-1.5">price</th>
              <th className="text-right font-body font-medium px-3 py-1.5">shares</th>
              <th className="text-right font-body font-medium px-3 py-1.5">value</th>
              <th className="text-right font-body font-medium px-3 py-1.5">when</th>
            </tr>
          </thead>
          <tbody>
            {posFills.slice(0, 40).map((f, i) => (
              <tr key={i} className="border-b border-line/60 last:border-b-0">
                <td className={`px-3 py-1.5 font-semibold ${f.side === 'SELL' ? 'text-coral-ink' : 'text-mint-deep'}`}>{f.side || '—'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums"><Redacted value={f.price} isPaid={isPaid}>{v => v.toFixed(3)}</Redacted></td>
                <td className="px-3 py-1.5 text-right tabular-nums text-ink-2">{fmtSize(f.size)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted">{f.price != null ? `$${(f.price * f.size).toFixed(2)}` : '—'}</td>
                <td className="px-3 py-1.5 text-right text-faint">{fmtRelShort(f.timestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {posFills.length > 40 && <div className="px-3 py-1.5 font-body text-[10px] text-faint">+{posFills.length - 40} more fills{url ? ' — full history on Polymarket' : ''}</div>}
      </div>

      {url && <div className="mt-2"><PlatformLink href={url} label="Polymarket market" /></div>}
    </div>
  );
}

function MiniStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-2.5 py-1.5">
      <div className="font-body text-[9px] uppercase tracking-wide text-muted/70">{label}</div>
      <div className="mt-0.5 tabular-nums">{children}</div>
    </div>
  );
}

// Price line with real fills marked as B/S dots at their real fill price.
function FillChart({ hist, fills, isPaid }: { hist: { t: number; p: number }[]; fills: RawFill[]; isPaid: boolean }) {
  const W = 640, H = 130, PAD = 8;
  const ts = hist.map(h => h.t);
  const minT = Math.min(...ts), maxT = Math.max(...ts), spanT = maxT - minT || 1;
  const px = (t: number) => PAD + ((t - minT) / spanT) * (W - 2 * PAD);
  const py = (p: number) => PAD + (1 - Math.max(0, Math.min(1, p))) * (H - 2 * PAD); // price 0..1
  const d = hist.map((h, i) => `${i === 0 ? 'M' : 'L'}${px(h.t).toFixed(1)},${py(h.p).toFixed(1)}`).join(' ');

  return (
    <div className="rounded-lg border border-line bg-surface p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[130px]" preserveAspectRatio="none">
        {[0, 0.5, 1].map(g => (
          <line key={g} x1={PAD} y1={py(g)} x2={W - PAD} y2={py(g)} stroke="var(--er-line, #E3ECE7)" strokeWidth="0.75" strokeDasharray={g === 0.5 ? '2 3' : undefined} />
        ))}
        <path d={d} fill="none" stroke="var(--er-violet, #5566D6)" strokeWidth="1.25" opacity="0.85" />
        {!isPaid ? null : fills.map((f, i) => {
          if (f.price == null || f.timestamp < minT - 60 || f.timestamp > maxT + 60) return null;
          const buy = f.side !== 'SELL';
          return <circle key={i} cx={px(f.timestamp)} cy={py(f.price)} r={3}
            fill={buy ? 'var(--er-mint-deep, #0A9D6B)' : 'var(--er-coral-ink, #D5552F)'}
            stroke="#fff" strokeWidth="0.75" />;
        })}
      </svg>
      <div className="mt-1 flex items-center gap-3 font-body text-[9.5px] text-faint">
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--er-mint-deep)' }} /> buy fill</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--er-coral-ink)' }} /> sell fill</span>
        <span className="ml-auto">real CLOB price · real fill prices{!isPaid && ' (fills hidden — upgrade)'}</span>
      </div>
    </div>
  );
}

// ── Honest note ───────────────────────────────────────────────────────────────
function HonestNote({ data }: { data: FeedResp }) {
  return (
    <div className="mt-5 rounded-xl border border-line bg-bg-soft/40 p-4 font-body text-[11px] text-muted leading-relaxed">
      <b className="text-ink-2">How this is built.</b> Every fill, price, and position here is a real on-chain
      Polymarket trade — live via the public CLOB activity WebSocket and re-synced from the keyless Data API
      (no key, no paid tier). Open positions show <b>unrealized</b> P&amp;L marked to the current mid; resolved
      positions settle at 100¢/0¢ with no exit price; closed positions show realized proceeds minus cost basis.
      Fills are kept to the most recent {data.fillsPerWallet ?? '—'} per wallet — older history lives on the
      trader&apos;s Polymarket profile. &ldquo;As of {hhmmss(data.updatedAt)}&rdquo; is the true last feed update
      {data.lastFullResyncAt && <> · last full re-sync {hhmmss(data.lastFullResyncAt)}</>}.
      {data.fillsCapped && ' A capped fill window means some closed-position cost bases are withheld rather than shown wrong.'}
    </div>
  );
}
