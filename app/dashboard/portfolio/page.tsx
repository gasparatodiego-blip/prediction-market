'use client';
import { useEffect, useState, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';

interface Position {
  id:         string;
  type:       string;
  title:      string;
  platformA?: string;
  platformB?: string;
  roiPct:     number;
  confidence: number;
  amountUsd:  number;
  trackedAt:  string;
  result?:    string;
  pnlUsd?:    number;
  notes?:     string;
}

interface Portfolio {
  totalInvested: number;
  totalPnl:      number;
  winCount:      number;
  lossCount:     number;
}

// Fee table (matches lib/fees.ts but duplicated here for client-side use)
const FEES: Record<string, number> = {
  kalshi: 0.07, polymarket: 0.02, manifold: 0, metaculus: 0,
  predictit: 0.15, betfair: 0.05, augur: 0.01, gnosis: 0.02, futuur: 0.02, goodjudgment: 0,
};

function getNetRoi(grossRoi: number, platformA?: string, platformB?: string): { netRoi: number; totalFeePct: number } {
  const feeA = FEES[platformA?.toLowerCase() ?? ''] ?? 0;
  const feeB = FEES[platformB?.toLowerCase() ?? ''] ?? 0;
  const totalFee = feeA + feeB;
  return { netRoi: +(grossRoi * (1 - totalFee)).toFixed(2), totalFeePct: +(totalFee * 100).toFixed(1) };
}

function sanitizeRoi(v: number) { return Math.min(500, Math.max(-100, isFinite(v) ? v : 0)); }

// Simple SVG P&L sparkline
function PnlChart({ positions }: { positions: Position[] }) {
  const resolved = positions.filter(p => p.result !== 'open' && p.pnlUsd != null).sort((a, b) => new Date(a.trackedAt).getTime() - new Date(b.trackedAt).getTime());
  if (resolved.length < 2) return <div className="text-xs text-gray-600 py-4 text-center">Resolve 2+ positions to see P&L chart</div>;

  let cumulative = 0;
  const points = resolved.map(p => { cumulative += (p.pnlUsd ?? 0); return cumulative; });
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const range = max - min || 1;
  const W = 400, H = 80;
  const xs = points.map((_, i) => (i / (points.length - 1)) * W);
  const ys = points.map(v => H - ((v - min) / range) * H);
  const path = points.map((_, i) => `${i === 0 ? 'M' : 'L'}${xs[i]},${ys[i]}`).join(' ');
  const zeroY = H - ((0 - min) / range) * H;
  const last  = points[points.length - 1];

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-300">Cumulative P&L</span>
        <span className={`text-sm font-bold ${last >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {last >= 0 ? '+' : ''}${last.toFixed(2)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none">
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="#374151" strokeWidth="1" strokeDasharray="4,4" />
        <path d={path} fill="none" stroke={last >= 0 ? '#22c55e' : '#ef4444'} strokeWidth="2" />
        {xs.map((x, i) => (
          <circle key={i} cx={x} cy={ys[i]} r="3" fill={points[i] >= 0 ? '#22c55e' : '#ef4444'} />
        ))}
      </svg>
    </div>
  );
}

export default function PortfolioPage() {
  const { data: session, status } = useSession();
  const [positions,  setPositions]  = useState<Position[]>([]);
  const [portfolio,  setPortfolio]  = useState<Portfolio | null>(null);
  const [showAdd,    setShowAdd]    = useState(false);
  const [loading,    setLoading]    = useState(true);
  const [addForm,    setAddForm]    = useState({
    type: 'prediction_market', title: '', platformA: '', platformB: '',
    roiPct: 0, confidence: 70, amountUsd: 100, notes: '',
  });

  useEffect(() => { if (status === 'authenticated') loadData(); }, [status]);

  async function loadData() {
    const res  = await fetch('/api/user/portfolio');
    const data = await res.json();
    setPositions(data.positions ?? []);
    setPortfolio(data.portfolio ?? null);
    setLoading(false);
  }

  async function addPosition(e: React.FormEvent) {
    e.preventDefault();
    await fetch('/api/user/portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(addForm) });
    setShowAdd(false);
    loadData();
  }

  async function updateResult(id: string, result: 'correct' | 'incorrect') {
    const pnlStr = prompt(result === 'correct' ? 'Actual profit $ (positive):' : 'Loss $ (use negative, e.g. -50):');
    if (pnlStr === null) return;
    const pnlUsd = parseFloat(pnlStr);
    if (isNaN(pnlUsd)) return;
    await fetch('/api/user/portfolio', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, result, pnlUsd }) });
    loadData();
  }

  const stats = useMemo(() => {
    const wins   = positions.filter(p => p.result === 'correct');
    const losses = positions.filter(p => p.result === 'incorrect');
    const open   = positions.filter(p => !p.result || p.result === 'open');
    const bestTrade = [...wins].sort((a, b) => (b.pnlUsd ?? 0) - (a.pnlUsd ?? 0))[0];
    const expectedPnl = open.reduce((s, p) => {
      const { netRoi } = getNetRoi(sanitizeRoi(p.roiPct), p.platformA, p.platformB);
      return s + p.amountUsd * (netRoi / 100) * (p.confidence / 100);
    }, 0);
    return { wins: wins.length, losses: losses.length, open: open.length, bestTrade, expectedPnl };
  }, [positions]);

  const winRate = stats.wins + stats.losses > 0
    ? Math.round(100 * stats.wins / (stats.wins + stats.losses)) : null;

  if (status === 'loading' || loading) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="flex gap-2">{[0,1,2].map(i => <div key={i} className="w-2.5 h-2.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: `${i*0.15}s` }} />)}</div>
    </div>
  );

  if (status === 'unauthenticated') return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center">
        <p className="text-gray-300 mb-4">Sign in to track your portfolio</p>
        <Link href="/auth/login" className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500">Sign In</Link>
      </div>
    </div>
  );

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <header className="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/90 backdrop-blur-sm px-4 md:px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Portfolio Tracker</h1>
          <p className="text-xs text-gray-500">{session?.user?.email}</p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/history" className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-xs hover:border-gray-500 hover:text-gray-300">📜 History</Link>
          <Link href="/dashboard" className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-xs hover:border-gray-500 hover:text-gray-300">← Dashboard</Link>
          <button onClick={() => setShowAdd(true)} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-500">+ Add Position</button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 space-y-5">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Total Invested',   value: `$${(portfolio?.totalInvested ?? 0).toFixed(2)}`, color: 'text-blue-400' },
            { label: 'Realised P&L',     value: `${(portfolio?.totalPnl ?? 0) >= 0 ? '+' : ''}$${(portfolio?.totalPnl ?? 0).toFixed(2)}`, color: (portfolio?.totalPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400' },
            { label: 'Win Rate',         value: winRate != null ? `${winRate}%` : '—', color: 'text-amber-400' },
            { label: 'Expected (open)',  value: `${stats.expectedPnl >= 0 ? '+' : ''}$${stats.expectedPnl.toFixed(2)}`, color: 'text-purple-400' },
          ].map(c => (
            <div key={c.label} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
              <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
              <div className="text-xs text-gray-500 mt-1">{c.label}</div>
            </div>
          ))}
        </div>
        {stats.bestTrade && (
          <div className="rounded-xl border border-green-800/40 bg-green-950/20 px-4 py-3 text-sm flex items-center gap-3">
            <span className="text-green-400 font-bold text-base">🏆</span>
            <span className="text-gray-400">Best trade:</span>
            <span className="text-green-300 font-semibold truncate">{stats.bestTrade.title.slice(0, 60)}</span>
            <span className="ml-auto text-green-400 font-bold">+${(stats.bestTrade.pnlUsd ?? 0).toFixed(2)}</span>
          </div>
        )}

        {/* P&L Chart */}
        <PnlChart positions={positions} />

        {/* Positions table */}
        {positions.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
            <div className="text-4xl mb-3">📊</div>
            <p className="text-gray-300 font-semibold">No positions tracked yet</p>
            <p className="text-gray-600 text-sm mt-1">Click &quot;Add Position&quot; to start tracking opportunities</p>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-800 overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/60 text-xs text-gray-500 uppercase">
                  {['Opportunity', 'Type', 'Gross ROI', 'Net ROI', 'Amount', 'Exp. Profit', 'Date', 'Result', 'P&L', ''].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left font-semibold first:pl-4">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {positions.map(p => {
                  const gross = sanitizeRoi(p.roiPct);
                  const { netRoi, totalFeePct } = getNetRoi(gross, p.platformA, p.platformB);
                  const flagRoi = gross > 100 && p.type === 'prediction_market';
                  const expProfit = p.amountUsd * (netRoi / 100) * (p.confidence / 100);
                  return (
                    <tr key={p.id} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-2.5 max-w-[180px]">
                        <p className="text-gray-200 text-xs line-clamp-2">{p.title}</p>
                        {p.platformA && <p className="text-gray-600 text-xs">{p.platformA}{p.platformB ? ` → ${p.platformB}` : ''}</p>}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-gray-500 capitalize whitespace-nowrap">{p.type.replace(/_/g,' ')}</td>
                      <td className="px-3 py-2.5 text-xs">
                        <span className={`font-bold ${flagRoi ? 'text-yellow-400' : 'text-green-400'}`}>{gross.toFixed(1)}%</span>
                        {flagRoi && <span className="ml-1 text-yellow-500" title="ROI >100% on prediction market — verify manually">⚠️</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        <span className={`font-bold ${netRoi >= 0 ? 'text-blue-400' : 'text-red-400'}`}>{netRoi.toFixed(1)}%</span>
                        {totalFeePct > 0 && <span className="text-gray-600 ml-1">(-{totalFeePct}%)</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-gray-300">${p.amountUsd.toFixed(0)}</td>
                      <td className="px-3 py-2.5 text-xs">
                        <span className={expProfit >= 0 ? 'text-purple-400' : 'text-red-400'}>
                          {expProfit >= 0 ? '+' : ''}${expProfit.toFixed(2)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-gray-600 whitespace-nowrap">{new Date(p.trackedAt).toLocaleDateString()}</td>
                      <td className="px-3 py-2.5">
                        <span className={`text-xs px-1.5 py-0.5 rounded-full border ${
                          p.result === 'correct'   ? 'border-green-700 bg-green-950/40 text-green-300' :
                          p.result === 'incorrect' ? 'border-red-700 bg-red-950/40 text-red-300' :
                          'border-gray-700 bg-gray-800 text-gray-500'
                        }`}>{p.result ?? 'open'}</span>
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        {p.pnlUsd != null ? (
                          <span className={p.pnlUsd >= 0 ? 'text-green-400 font-semibold' : 'text-red-400 font-semibold'}>
                            {p.pnlUsd >= 0 ? '+' : ''}${p.pnlUsd.toFixed(2)}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        {(!p.result || p.result === 'open') && (
                          <div className="flex gap-1">
                            <button onClick={() => updateResult(p.id, 'correct')}
                              className="px-1.5 py-0.5 text-xs rounded border border-green-700 text-green-400 hover:bg-green-900/40">✓</button>
                            <button onClick={() => updateResult(p.id, 'incorrect')}
                              className="px-1.5 py-0.5 text-xs rounded border border-red-700 text-red-400 hover:bg-red-900/40">✗</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add position modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={() => setShowAdd(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg text-white mb-4">Track Opportunity</h3>
            <form onSubmit={addPosition} className="space-y-3">
              <input required placeholder="Opportunity title" value={addForm.title}
                onChange={e => setAddForm(f => ({ ...f, title: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500" />
              <div className="grid grid-cols-2 gap-2">
                <select value={addForm.type} onChange={e => setAddForm(f => ({ ...f, type: e.target.value }))}
                  className="col-span-2 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none">
                  <option value="prediction_market">Prediction Market Arb</option>
                  <option value="funding_rate">Funding Rate</option>
                  <option value="cex_arb">CEX Arb</option>
                  <option value="sports_arb">Sports Arb</option>
                  <option value="cash_carry">Cash & Carry</option>
                </select>
                <input placeholder="Platform A (e.g. kalshi)" value={addForm.platformA}
                  onChange={e => setAddForm(f => ({ ...f, platformA: e.target.value }))}
                  className="px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500" />
                <input placeholder="Platform B (optional)" value={addForm.platformB}
                  onChange={e => setAddForm(f => ({ ...f, platformB: e.target.value }))}
                  className="px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'ROI %', key: 'roiPct',     type: 'number', step: '0.1' },
                  { label: 'Conf %', key: 'confidence', type: 'number', min: 0, max: 100 },
                  { label: 'Amount $', key: 'amountUsd', type: 'number', step: '1' },
                ].map(f => (
                  <div key={f.key}>
                    <label className="text-xs text-gray-500 mb-1 block">{f.label}</label>
                    <input type={f.type} step={(f as any).step} min={(f as any).min} max={(f as any).max}
                      value={(addForm as any)[f.key]}
                      onChange={e => setAddForm(prev => ({ ...prev, [f.key]: parseFloat(e.target.value) }))}
                      className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500" />
                  </div>
                ))}
              </div>
              {addForm.platformA && (
                <div className="text-xs text-gray-500 bg-gray-800/50 rounded-lg px-3 py-2">
                  {(() => {
                    const { netRoi, totalFeePct } = getNetRoi(addForm.roiPct, addForm.platformA, addForm.platformB);
                    return `Net ROI after fees: ${netRoi.toFixed(1)}% (−${totalFeePct}%) → Expected profit: $${(addForm.amountUsd * netRoi / 100 * addForm.confidence / 100).toFixed(2)}`;
                  })()}
                </div>
              )}
              <textarea placeholder="Notes (optional)" value={addForm.notes}
                onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))}
                rows={2}
                className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500 resize-none" />
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 py-2 rounded-lg border border-gray-700 text-gray-400 text-sm hover:border-gray-500">Cancel</button>
                <button type="submit" className="flex-1 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-500">Track It</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
