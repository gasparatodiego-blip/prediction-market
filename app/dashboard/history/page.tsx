'use client';
import { useEffect, useState, useMemo } from 'react';
import SectionHelp from '@/app/components/SectionHelp';
import { Redacted } from '@/app/components/ui/Redacted';
import { safeNum } from '@/lib/fmt-safe';

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
  prediction_market: 'border-violet/40 text-violet',
  funding_rate:      'border-mint/30 text-mint',
  cex_arb:           'border-gold/40 text-gold',
  sports_arb:        'border-mint-deep/40 text-mint-deep',
  cash_carry:        'border-gold/30 text-gold',
};

function typeChip(t: string) {
  return TYPE_CHIP[t] ?? 'border-line text-ink-2';
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
      `"${e.ts}","${e.status}",${e.opps},${safeNum(e.avgConf)},"${e.best?.type ?? ''}","${(e.best?.title ?? '').replace(/"/g, '""')}",${e.alertsSent},${e.fng ?? ''},${safeNum(e.accuracy7d)}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url; a.download = 'scanner-history.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  const selectClass = "px-3 py-1.5 rounded-button border border-line bg-bg-soft text-xs text-ink-2 font-body focus:outline-none focus:border-mint/60";

  return (
    <main className="text-ink">
      <div className="border-b border-line bg-surface/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <span className="font-body font-semibold text-ink text-xs uppercase tracking-widest">SCAN HISTORY</span>
          {data && (
            <span className="font-body text-xs text-muted">
              {data.totalScans} scans · {data.totalOpps.toLocaleString()} total opps
            </span>
          )}
          <button onClick={exportCsv}
            className="ml-auto px-3 py-1.5 rounded-button border border-line text-ink-2 font-body text-xs hover:border-mint/30 hover:text-ink transition-colors duration-100">
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
              <div key={s.label} className="rounded-card border border-line bg-surface p-4 shadow-card">
                <div className="font-body text-xs text-muted uppercase tracking-widest mb-1">{s.label}</div>
                <div className="font-mono text-lg font-bold tabular-nums text-ink">{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by title…"
            className="flex-1 min-w-40 px-3 py-1.5 rounded-button border border-line bg-bg-soft text-xs text-ink-2 font-body focus:outline-none focus:border-mint/60 placeholder:text-muted" />
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
          <div className="text-center py-12 font-body text-xs text-muted">LOADING HISTORY…</div>
        ) : !filtered.length ? (
          <div className="text-center py-12 font-body text-xs text-muted">NO SCANS FOUND FOR SELECTED FILTERS</div>
        ) : (
          <div className="rounded-card border border-line overflow-hidden shadow-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface text-muted text-xs font-body uppercase tracking-widest">
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
                  <tr key={e.ts + i} className="border-b border-line/50 hover:bg-bg-soft/30 transition-colors duration-75">
                    <td className="px-4 py-2.5 text-muted text-xs font-mono tabular-nums whitespace-nowrap">{fmtDate(e.ts)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`px-1.5 py-0.5 rounded-sm border font-body text-xs uppercase tracking-wide ${
                        e.status === 'success'
                          ? 'border-mint-deep/40 bg-mint-tint text-mint-deep'
                          : 'border-coral-ink/40 bg-coral-tint text-coral-ink'
                      }`}>
                        {e.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold font-mono tabular-nums text-ink">{e.opps}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-ink-2">
                      <Redacted value={e.avgConf}>{v => `${v}%`}</Redacted>
                    </td>
                    <td className="px-4 py-2.5 max-w-xs">
                      <Redacted value={e.best}>
                        {best => (
                          <div className="flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded-sm border bg-bg-soft font-body text-xs uppercase tracking-wide shrink-0 ${typeChip(best.type)}`}>
                              {best.type.replace(/_/g, ' ')}
                            </span>
                            <span className="text-ink-2 truncate font-body text-xs">{best.title?.slice(0, 50)}</span>
                            <span className="text-mint font-bold font-mono tabular-nums text-xs ml-auto shrink-0">{best.confidence}%</span>
                          </div>
                        )}
                      </Redacted>
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted font-mono tabular-nums">{e.fng ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {e.alertsSent > 0
                        ? <span className="text-gold font-bold">{e.alertsSent}</span>
                        : <span className="text-muted">0</span>}
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
