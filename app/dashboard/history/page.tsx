'use client';
import { useEffect, useState, useMemo } from 'react';
import SectionHelp from '@/app/components/SectionHelp';

interface HistoryEntry {
  ts:         string;
  status:     string;
  opps:       number;
  avgConf:    number | null;
  best:       { type: string; title: string; confidence: number } | null;
  alertsSent: number;
  fng:        number | null;
  matches:    number;
  accuracy7d: number | null;
}

interface HistoryData {
  history:     HistoryEntry[];
  totalScans:  number;
  totalOpps:   number;
  totalAlerts: number;
  lastScan:    string | null;
  currentOpps: any[];
}

const TYPE_CHIP: Record<string, string> = {
  prediction_market: 'border-accent/40 text-accent-bright',
  funding_rate:      'border-accent/30 text-accent',
  cex_arb:           'border-warning/40 text-warning',
  sports_arb:        'border-positive/40 text-positive',
  cash_carry:        'border-warning/30 text-warning',
};

function typeChip(t: string) {
  return TYPE_CHIP[t] ?? 'border-border text-text-secondary';
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function HistoryPage() {
  const [data,      setData]      = useState<HistoryData | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [typeF,     setTypeF]     = useState('all');
  const [statusF,   setStatusF]   = useState('all');
  const [dateRange, setDateRange] = useState(7);

  useEffect(() => {
    fetch('/api/user/history').then(r => r.json()).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    const cutoff = Date.now() - dateRange * 86400000;
    return data.history
      .filter(e => new Date(e.ts).getTime() > cutoff)
      .filter(e => statusF === 'all' || e.status === statusF)
      .filter(e => typeF === 'all' || e.best?.type === typeF)
      .filter(e => !search || e.best?.title?.toLowerCase().includes(search.toLowerCase()))
      .reverse();
  }, [data, dateRange, statusF, typeF, search]);

  function exportCsv() {
    if (!filtered.length) return;
    const header = 'Date,Status,Opportunities,AvgConfidence,BestType,BestTitle,Alerts,FNG,Accuracy7d\n';
    const rows   = filtered.map(e =>
      `"${e.ts}","${e.status}",${e.opps},${e.avgConf ?? ''},"${e.best?.type ?? ''}","${(e.best?.title ?? '').replace(/"/g, '""')}",${e.alertsSent},${e.fng ?? ''},${e.accuracy7d ?? ''}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url; a.download = 'scanner-history.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  const selectClass = "px-3 py-1.5 rounded border border-border bg-bg-elevated text-xs text-text-secondary font-mono focus:outline-none focus:border-accent/60";

  return (
    <main className="text-text-primary">
      <div className="border-b border-border bg-bg-panel/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <span className="font-semibold text-text-primary text-xs font-mono uppercase tracking-widest">SCAN HISTORY</span>
          {data && (
            <span className="text-xs text-text-muted font-mono">
              {data.totalScans} scans · {data.totalOpps.toLocaleString()} total opps
            </span>
          )}
          <button onClick={exportCsv}
            className="ml-auto px-3 py-1.5 rounded border border-border text-text-secondary text-xs font-mono hover:border-accent/30 hover:text-text-primary transition-colors duration-100">
            EXPORT CSV
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <SectionHelp section="history" />
        {/* Summary stats */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'TOTAL SCANS',         value: data.totalScans },
              { label: 'OPPORTUNITIES FOUND', value: data.totalOpps.toLocaleString() },
              { label: 'ALERTS SENT',         value: data.totalAlerts },
              { label: 'LAST SCAN',           value: data.lastScan ? fmtDate(data.lastScan) : '—' },
            ].map(s => (
              <div key={s.label} className="rounded border border-border bg-bg-panel p-4">
                <div className="text-xs text-text-muted font-mono uppercase tracking-widest mb-1">{s.label}</div>
                <div className="text-lg font-bold font-mono tabular-nums text-text-primary">{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by title…"
            className="flex-1 min-w-40 px-3 py-1.5 rounded border border-border bg-bg-elevated text-xs text-text-secondary font-mono focus:outline-none focus:border-accent/60 placeholder:text-text-muted" />
          <select value={dateRange} onChange={e => setDateRange(+e.target.value)} className={selectClass}>
            <option value={1}>Last 24h</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={999}>All time</option>
          </select>
          <select value={statusF} onChange={e => setStatusF(e.target.value)} className={selectClass}>
            <option value="all">All status</option>
            <option value="success">Success</option>
            <option value="crash">Error</option>
          </select>
          <select value={typeF} onChange={e => setTypeF(e.target.value)} className={selectClass}>
            <option value="all">All types</option>
            <option value="prediction_market">Prediction Market</option>
            <option value="funding_rate">Funding Rate</option>
            <option value="cex_arb">CEX Arb</option>
            <option value="sports_arb">Sports Arb</option>
            <option value="cash_carry">Cash &amp; Carry</option>
          </select>
        </div>

        {/* Table */}
        {loading ? (
          <div className="text-center py-12 text-text-muted font-mono text-xs">LOADING HISTORY…</div>
        ) : !filtered.length ? (
          <div className="text-center py-12 text-text-muted font-mono text-xs">NO SCANS FOUND FOR SELECTED FILTERS</div>
        ) : (
          <div className="rounded border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-bg-panel text-text-muted text-xs font-mono uppercase tracking-widest">
                  <th className="px-4 py-2.5 text-left font-semibold">Date</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Status</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Opps</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Avg Conf</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Best Opportunity</th>
                  <th className="px-4 py-2.5 text-right font-semibold">FNG</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Alerts</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e, i) => (
                  <tr key={e.ts + i} className="border-b border-border/50 hover:bg-bg-elevated/30 transition-colors duration-75">
                    <td className="px-4 py-2.5 text-text-muted text-xs font-mono tabular-nums whitespace-nowrap">{fmtDate(e.ts)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`px-1.5 py-0.5 rounded border text-xs font-mono uppercase tracking-wide ${
                        e.status === 'success'
                          ? 'border-positive/40 bg-positive/10 text-positive'
                          : 'border-negative/40 bg-negative/10 text-negative'
                      }`}>
                        {e.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold font-mono tabular-nums text-text-primary">{e.opps}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-text-secondary">
                      {e.avgConf != null ? `${e.avgConf}%` : '—'}
                    </td>
                    <td className="px-4 py-2.5 max-w-xs">
                      {e.best ? (
                        <div className="flex items-center gap-2">
                          <span className={`px-1.5 py-0.5 rounded border bg-bg-elevated text-xs font-mono uppercase tracking-wide shrink-0 ${typeChip(e.best.type)}`}>
                            {e.best.type.replace(/_/g, ' ')}
                          </span>
                          <span className="text-text-secondary truncate text-xs font-mono">{e.best.title?.slice(0, 50)}</span>
                          <span className="text-accent-bright text-xs font-bold font-mono tabular-nums ml-auto shrink-0">{e.best.confidence}%</span>
                        </div>
                      ) : <span className="text-text-muted font-mono">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-text-muted font-mono tabular-nums">{e.fng ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {e.alertsSent > 0
                        ? <span className="text-warning font-bold">{e.alertsSent}</span>
                        : <span className="text-text-muted">0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
