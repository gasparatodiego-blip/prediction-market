'use client';

import { useState, useEffect, useCallback } from 'react';
import SectionHelp from '@/app/components/SectionHelp';

// ── Types ─────────────────────────────────────────────────────────────────
interface Signal {
  conditionId:      string;
  title:            string;
  coin:             string;
  duration:         string;
  sourceConfidence: 'canonical' | 'proxy';
  timeRemainingSec: number;
  openPrice:        number | null;
  currentPrice:     number | null;
  priceMoveP:       number | null;
  fairP:            number;
  polyPUp:          number;
  divergence:       number;
  flaggedSide:      'Up' | 'Down';
  edgeP:            number;
  bestAsk:          number | null;
  capacityUsdc:     number | null;
  flaggedAt:        string;
  disclaimer:       string;
}

interface MonitoredMarket {
  conditionId:      string;
  title:            string;
  coin:             string;
  duration:         string;
  sourceConfidence: 'canonical' | 'proxy';
  windowEnd:        number;
  polyPUp:          number | null;
  openPrice:        number | null;
  currentSpot:      number | null;
}

interface Stats {
  totalFlagged:  number;
  totalResolved: number;
  totalWon:      number;
  hitRatePct:    number | null;
  bySourceConfidence: {
    canonical: { flagged: number; resolved: number; won: number; hitRatePct: number | null };
    proxy:     { flagged: number; resolved: number; won: number; hitRatePct: number | null };
  };
  note: string;
}

interface LogEntry {
  conditionId:      string;
  title:            string;
  coin:             string;
  duration:         string;
  sourceConfidence: 'canonical' | 'proxy';
  fairP:            number;
  polyPUp:          number;
  divergence:       number;
  flaggedSide:      'Up' | 'Down';
  edgeP:            number;
  timeRemainingSec: number;
  flaggedAt:        string;
  resolvedAt:       string | null;
  winner:           string | null;
  flaggedSideWon:   boolean | null;
}

interface HFTData {
  agentStatus:      'running' | 'stale' | 'offline';
  updatedAt:        string | null;
  liveSignals:      Signal[];
  monitoredMarkets: MonitoredMarket[];
  stats:            Stats | null;
  logEntries:       LogEntry[];
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtTime(sec: number) {
  if (sec <= 0) return '—';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}m${s.toString().padStart(2,'0')}s` : `${s}s`;
}

function fmtPct(n: number | null) {
  if (n === null) return '—';
  return (n * 100).toFixed(1) + '%';
}

function fmtPrice(n: number | null) {
  if (n === null) return '—';
  if (n > 1000)  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n > 1)     return '$' + n.toFixed(4);
  return '$' + n.toFixed(6);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Sub-components ────────────────────────────────────────────────────────

function AgentBanner({ status, updatedAt }: { status: string; updatedAt: string | null }) {
  const cfg = {
    running: { dot: 'bg-positive animate-pulse', text: 'text-positive', label: 'AGENT RUNNING' },
    stale:   { dot: 'bg-warning',                text: 'text-warning',  label: 'AGENT STALE'   },
    offline: { dot: 'bg-negative',               text: 'text-negative', label: 'AGENT OFFLINE' },
  }[status] ?? { dot: 'bg-text-muted', text: 'text-text-muted', label: 'UNKNOWN' };

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border border-border bg-bg-panel rounded text-xs font-mono">
      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />
      <span className={`font-semibold ${cfg.text}`}>{cfg.label}</span>
      {updatedAt && (
        <span className="text-text-muted ml-auto">last update {fmtDate(updatedAt)}</span>
      )}
      {status === 'offline' && (
        <span className="text-text-muted ml-2">— run <code className="bg-bg-elevated px-1">pm2 start agent16-poly-hft</code></span>
      )}
    </div>
  );
}

function ConfidenceBadge({ conf }: { conf: 'canonical' | 'proxy' }) {
  return conf === 'canonical'
    ? <span className="px-1.5 py-0.5 rounded border border-positive/40 bg-positive/10 text-positive text-[9px] font-mono uppercase tracking-wider">CANONICAL</span>
    : <span className="px-1.5 py-0.5 rounded border border-warning/40 bg-warning/10 text-warning  text-[9px] font-mono uppercase tracking-wider">PROXY</span>;
}

function SideChip({ side }: { side: 'Up' | 'Down' }) {
  return side === 'Up'
    ? <span className="px-1.5 py-0.5 rounded border border-positive/40 bg-positive/10 text-positive text-[9px] font-mono uppercase">UP</span>
    : <span className="px-1.5 py-0.5 rounded border border-negative/40 bg-negative/10 text-negative text-[9px] font-mono uppercase">DOWN</span>;
}

function SignalCard({ sig }: { sig: Signal }) {
  const [open, setOpen] = useState(false);
  const move = sig.priceMoveP ?? 0;
  const moveSign = move >= 0 ? '+' : '';

  return (
    <div className="border border-accent/30 bg-bg-elevated rounded p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-text-primary font-mono text-xs font-semibold">{sig.title}</p>
          <p className="text-text-muted font-mono text-[10px] mt-0.5">{sig.duration} window · {fmtTime(sig.timeRemainingSec)} remaining</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ConfidenceBadge conf={sig.sourceConfidence} />
          <SideChip side={sig.flaggedSide} />
          <span className="text-accent-bright font-mono font-bold text-sm">{(sig.edgeP * 100).toFixed(1)}pp</span>
        </div>
      </div>

      {/* Price row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
        {[
          { label: 'Open', value: fmtPrice(sig.openPrice) },
          { label: 'Current', value: fmtPrice(sig.currentPrice), sub: `${moveSign}${fmtPct(sig.priceMoveP)}` },
          { label: 'Fair P(Up)', value: (sig.fairP * 100).toFixed(1) + '%' },
          { label: 'Poly P(Up)', value: (sig.polyPUp * 100).toFixed(1) + '%' },
        ].map(({ label, value, sub }) => (
          <div key={label} className="bg-bg-panel rounded p-2 border border-border/50">
            <p className="text-text-muted font-mono text-[9px] uppercase tracking-widest">{label}</p>
            <p className="text-text-primary font-mono font-bold text-sm mt-0.5">{value}</p>
            {sub && <p className="text-text-secondary font-mono text-[10px]">{sub}</p>}
          </div>
        ))}
      </div>

      {/* Depth + disclaimer toggle */}
      <div className="flex items-center gap-4 text-xs font-mono text-text-secondary">
        {sig.capacityUsdc !== null && (
          <span>depth: <span className="text-text-primary font-semibold">${sig.capacityUsdc?.toLocaleString()}</span> at best</span>
        )}
        {sig.bestAsk !== null && (
          <span>ask: <span className="text-text-primary font-semibold">{sig.bestAsk.toFixed(3)}</span></span>
        )}
        <button
          onClick={() => setOpen(!open)}
          className="ml-auto text-text-muted hover:text-text-secondary underline decoration-dotted underline-offset-2"
        >
          {open ? 'hide' : 'disclaimer ▸'}
        </button>
      </div>
      {open && (
        <p className="text-[10px] font-mono text-text-muted leading-relaxed border-t border-border/50 pt-2">
          {sig.disclaimer}
        </p>
      )}
    </div>
  );
}

function StatsPanel({ stats }: { stats: Stats }) {
  const hitCls = (pct: number | null) =>
    pct === null ? 'text-text-muted' :
    pct >= 55    ? 'text-positive'   :
    pct >= 45    ? 'text-text-primary' : 'text-negative';

  const row = (label: string, conf: Stats['bySourceConfidence']['canonical'], note: string) => (
    <div className="flex items-center gap-3 py-2 border-b border-border/40 last:border-0 font-mono text-xs">
      <span className="text-text-secondary w-24 shrink-0">{label}</span>
      <span className="text-text-primary tabular-nums w-14">{conf.flagged} flagged</span>
      <span className="text-text-muted tabular-nums w-18">{conf.resolved} resolved</span>
      <span className={`font-bold tabular-nums w-16 ${hitCls(conf.hitRatePct)}`}>
        {conf.hitRatePct !== null ? conf.hitRatePct.toFixed(1) + '%' : '—'} win
      </span>
      <span className="text-text-muted text-[10px]">{note}</span>
    </div>
  );

  return (
    <div className="border border-border bg-bg-panel rounded p-4 space-y-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">MEASUREMENT LOG</p>

      <div className="grid grid-cols-3 gap-3 text-center">
        {[
          { label: 'FLAGGED',  value: stats.totalFlagged  },
          { label: 'RESOLVED', value: stats.totalResolved },
          { label: 'HIT RATE', value: stats.hitRatePct !== null ? stats.hitRatePct.toFixed(1) + '%' : '—' },
        ].map(({ label, value }) => (
          <div key={label} className="bg-bg-elevated rounded p-3 border border-border/50">
            <p className="text-text-muted font-mono text-[9px] uppercase tracking-widest">{label}</p>
            <p className="text-text-primary font-mono font-bold text-lg mt-0.5">{value}</p>
          </div>
        ))}
      </div>

      <div className="mt-2">
        {row('Canonical', stats.bySourceConfidence.canonical, 'hourly → Binance (primary)')}
        {row('Proxy',     stats.bySourceConfidence.proxy,     '5m/15m/4h → Chainlink via Binance (experimental)')}
      </div>

      <p className="text-[10px] font-mono text-text-muted leading-relaxed border-t border-border/50 pt-2">
        {stats.note}
      </p>
    </div>
  );
}

function MonitorTable({ markets }: { markets: MonitoredMarket[] }) {
  if (!markets.length) return null;
  const nowSec = Date.now() / 1000;
  return (
    <div className="border border-border rounded overflow-hidden">
      <div className="bg-bg-panel px-4 py-2 border-b border-border">
        <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
          MONITORING {markets.length} MARKET{markets.length !== 1 ? 'S' : ''} — NO DIVERGENCE ABOVE THRESHOLD
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted text-[9px] uppercase tracking-widest">
              <th className="px-3 py-2 text-left">Market</th>
              <th className="px-3 py-2 text-center">Dur</th>
              <th className="px-3 py-2 text-center">Source</th>
              <th className="px-3 py-2 text-right">Poly P(Up)</th>
              <th className="px-3 py-2 text-right">Open</th>
              <th className="px-3 py-2 text-right">Spot</th>
              <th className="px-3 py-2 text-right">Expires</th>
            </tr>
          </thead>
          <tbody>
            {markets.map(m => {
              const tRem = m.windowEnd - nowSec;
              return (
                <tr key={m.conditionId} className="border-b border-border/40 hover:bg-bg-elevated/30">
                  <td className="px-3 py-2 text-text-secondary max-w-xs truncate">{m.title}</td>
                  <td className="px-3 py-2 text-center text-text-muted">{m.duration}</td>
                  <td className="px-3 py-2 text-center"><ConfidenceBadge conf={m.sourceConfidence} /></td>
                  <td className="px-3 py-2 text-right text-text-primary tabular-nums">
                    {m.polyPUp !== null ? (m.polyPUp * 100).toFixed(0) + '%' : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-text-muted tabular-nums">{fmtPrice(m.openPrice)}</td>
                  <td className="px-3 py-2 text-right text-text-muted tabular-nums">{fmtPrice(m.currentSpot)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${tRem < 120 ? 'text-warning' : 'text-text-muted'}`}>
                    {fmtTime(Math.round(tRem))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LogTable({ entries }: { entries: LogEntry[] }) {
  if (!entries.length) return null;
  return (
    <div className="border border-border rounded overflow-hidden">
      <div className="bg-bg-panel px-4 py-2 border-b border-border flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">MEASUREMENT LOG — LAST {entries.length} ENTRIES</p>
        <p className="font-mono text-[10px] text-text-muted">newest first</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted text-[9px] uppercase tracking-widest">
              <th className="px-3 py-2 text-left">Flagged</th>
              <th className="px-3 py-2 text-left">Market</th>
              <th className="px-3 py-2 text-center">Src</th>
              <th className="px-3 py-2 text-right">Fair P</th>
              <th className="px-3 py-2 text-right">Poly P</th>
              <th className="px-3 py-2 text-center">Side</th>
              <th className="px-3 py-2 text-right">Edge</th>
              <th className="px-3 py-2 text-center">T-rem</th>
              <th className="px-3 py-2 text-center">Winner</th>
              <th className="px-3 py-2 text-center">Result</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => {
              const won = e.flaggedSideWon;
              return (
                <tr key={i} className="border-b border-border/40 hover:bg-bg-elevated/30">
                  <td className="px-3 py-2 text-text-muted whitespace-nowrap">{fmtDate(e.flaggedAt)}</td>
                  <td className="px-3 py-2 text-text-secondary max-w-[180px] truncate">{e.title}</td>
                  <td className="px-3 py-2 text-center"><ConfidenceBadge conf={e.sourceConfidence} /></td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-primary">{(e.fairP * 100).toFixed(0)}%</td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-muted">{(e.polyPUp * 100).toFixed(0)}%</td>
                  <td className="px-3 py-2 text-center"><SideChip side={e.flaggedSide} /></td>
                  <td className="px-3 py-2 text-right tabular-nums text-accent">{(e.edgeP * 100).toFixed(1)}pp</td>
                  <td className="px-3 py-2 text-center text-text-muted">{fmtTime(e.timeRemainingSec)}</td>
                  <td className="px-3 py-2 text-center">
                    {e.winner
                      ? <span className={`font-bold ${e.winner === 'Up' ? 'text-positive' : 'text-negative'}`}>{e.winner}</span>
                      : <span className="text-text-muted">pending</span>}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {won === null
                      ? <span className="text-text-muted">—</span>
                      : won
                        ? <span className="text-positive font-bold">WIN</span>
                        : <span className="text-negative font-bold">LOSS</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────
export default function HFTPage() {
  const [data, setData] = useState<HFTData | null>(null);
  const [err,  setErr]  = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const r = await fetch('/api/poly-hft', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setData(await r.json());
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const status = data?.agentStatus ?? 'offline';

  return (
    <div className="max-w-[1100px] mx-auto px-4 py-6 space-y-5">

      {/* Header */}
      <div>
        <h1 className="font-mono text-sm uppercase tracking-widest text-text-primary">HFT / 5-MIN SIGNAL</h1>
        <p className="font-mono text-[10px] text-text-muted mt-0.5">
          POLYMARKET SHORT-MARKET DIVERGENCE DETECTOR · SIGNAL-ONLY · NEVER TRADES
        </p>
      </div>

      <SectionHelp section="hft" />

      <AgentBanner status={status} updatedAt={data?.updatedAt ?? null} />

      {/* Honest caveat block */}
      <div className="border border-border/40 bg-bg-panel/40 px-4 py-3 rounded text-[11px] font-mono text-text-muted space-y-1">
        <p className="text-text-secondary font-semibold text-[10px] uppercase tracking-widest mb-2">What this is and isn&apos;t</p>
        <p>This is a <span className="text-text-primary">measurement tool</span>, not a trading signal you can act on reliably.
          Fair value uses a log-normal digital-option formula (±55% annual vol). Edge, if real, is sharpest in the final few seconds
          where polling latency alone may prevent execution.</p>
        <p><span className="text-positive font-bold">CANONICAL</span> = hourly markets resolving on Binance 1H candle — same source as our model.
           <span className="ml-2 text-warning font-bold">PROXY</span> = 5m/15m/4h resolving on Chainlink; we use Binance spot as a proxy.
           Basis between Binance and Chainlink can create <span className="text-warning">false divergences</span> on proxy markets.</p>
        <p>The MEASUREMENT LOG records every flagged divergence and the actual resolution outcome. Accumulate ≥50 resolved canonical signals before drawing any conclusions.</p>
      </div>

      {err && (
        <div className="border border-negative/30 bg-negative/5 px-4 py-3 rounded font-mono text-xs text-negative">
          API error: {err}
        </div>
      )}

      {!data && !err && (
        <div className="text-center py-12 text-text-muted font-mono text-xs animate-pulse">LOADING…</div>
      )}

      {data && (
        <>
          {/* Live signals */}
          {data.liveSignals.length > 0 ? (
            <div className="space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
                LIVE DIVERGENCES ({data.liveSignals.length})
              </p>
              {data.liveSignals.map(sig => <SignalCard key={sig.conditionId} sig={sig} />)}
            </div>
          ) : (
            status === 'running' && (
              <div className="border border-border bg-bg-panel rounded px-4 py-5 text-center font-mono text-xs text-text-muted">
                No divergences above {'>'}5pp threshold — monitoring {data.monitoredMarkets.length} market{data.monitoredMarkets.length !== 1 ? 's' : ''}
              </div>
            )
          )}

          {/* Monitored markets table */}
          <MonitorTable markets={data.monitoredMarkets} />

          {/* Stats */}
          {data.stats && <StatsPanel stats={data.stats} />}

          {/* Log table */}
          <LogTable entries={data.logEntries} />
        </>
      )}
    </div>
  );
}
