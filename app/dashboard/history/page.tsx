'use client';
import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';

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

const TYPE_COLORS: Record<string, string> = {
  prediction_market: 'bg-blue-900/40 text-blue-300 border-blue-700',
  funding_rate:      'bg-purple-900/40 text-purple-300 border-purple-700',
  cex_arb:           'bg-yellow-900/40 text-yellow-300 border-yellow-700',
  sports_arb:        'bg-green-900/40 text-green-300 border-green-700',
  cash_carry:        'bg-orange-900/40 text-orange-300 border-orange-700',
};

function typeColor(t: string) {
  return TYPE_COLORS[t] ?? 'bg-gray-900/40 text-gray-300 border-gray-700';
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
  const [dateRange, setDateRange] = useState(7); // days

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

  return (
    <main className="bg-gray-950 text-white min-h-screen">
      <nav className="border-b border-gray-800 bg-gray-900/80 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          <Link href="/dashboard" className="text-gray-400 hover:text-white text-sm">← Dashboard</Link>
          <span className="text-gray-600">|</span>
          <span className="font-semibold">Scan History</span>
          {data && (
            <span className="text-xs text-gray-500 ml-2">
              {data.totalScans} scans · {data.totalOpps.toLocaleString()} total opportunities
            </span>
          )}
          <button onClick={exportCsv} className="ml-auto px-3 py-1 rounded-lg border border-gray-700 text-gray-400 text-xs hover:border-gray-500 hover:text-white transition-colors">
            Export CSV
          </button>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        {/* Summary stats */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Total Scans', value: data.totalScans },
              { label: 'Opportunities Found', value: data.totalOpps.toLocaleString() },
              { label: 'Alerts Sent', value: data.totalAlerts },
              { label: 'Last Scan', value: data.lastScan ? fmtDate(data.lastScan) : '—' },
            ].map(s => (
              <div key={s.label} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                <div className="text-xs text-gray-500 mb-1">{s.label}</div>
                <div className="text-xl font-bold">{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by title…"
            className="flex-1 min-w-40 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:outline-none focus:border-blue-500" />
          <select value={dateRange} onChange={e => setDateRange(+e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:outline-none">
            <option value={1}>Last 24h</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={999}>All time</option>
          </select>
          <select value={statusF} onChange={e => setStatusF(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:outline-none">
            <option value="all">All status</option>
            <option value="success">Success</option>
            <option value="crash">Error</option>
          </select>
          <select value={typeF} onChange={e => setTypeF(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 focus:outline-none">
            <option value="all">All types</option>
            <option value="prediction_market">Prediction Market</option>
            <option value="funding_rate">Funding Rate</option>
            <option value="cex_arb">CEX Arb</option>
            <option value="sports_arb">Sports Arb</option>
            <option value="cash_carry">Cash & Carry</option>
          </select>
        </div>

        {/* Table */}
        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading history…</div>
        ) : !filtered.length ? (
          <div className="text-center py-12 text-gray-500">No scans found for the selected filters.</div>
        ) : (
          <div className="rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/60 text-gray-500 text-xs">
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
                  <tr key={e.ts + i} className="border-b border-gray-800/50 hover:bg-gray-900/30 transition-colors">
                    <td className="px-4 py-2.5 text-gray-400 text-xs whitespace-nowrap">{fmtDate(e.ts)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`px-2 py-0.5 rounded text-xs font-semibold ${e.status === 'success' ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
                        {e.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold tabular-nums">{e.opps}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-300">
                      {e.avgConf != null ? `${e.avgConf}%` : '—'}
                    </td>
                    <td className="px-4 py-2.5 max-w-xs">
                      {e.best ? (
                        <div className="flex items-center gap-2">
                          <span className={`px-1.5 py-0.5 rounded border text-xs ${typeColor(e.best.type)}`}>{e.best.type.replace(/_/g, ' ')}</span>
                          <span className="text-gray-300 truncate text-xs">{e.best.title?.slice(0, 50)}</span>
                          <span className="text-blue-400 text-xs font-bold ml-auto">{e.best.confidence}%</span>
                        </div>
                      ) : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-gray-500">{e.fng ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right">
                      {e.alertsSent > 0
                        ? <span className="text-yellow-400 font-bold">{e.alertsSent}</span>
                        : <span className="text-gray-600">0</span>}
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
