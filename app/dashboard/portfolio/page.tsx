'use client';
import { useEffect, useState } from 'react';
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

export default function PortfolioPage() {
  const { data: session, status } = useSession();
  const [positions,  setPositions]  = useState<Position[]>([]);
  const [portfolio,  setPortfolio]  = useState<Portfolio | null>(null);
  const [showAdd,    setShowAdd]    = useState(false);
  const [loading,    setLoading]    = useState(true);
  const [addForm, setAddForm] = useState({ type: 'prediction_market', title: '', platformA: '', platformB: '', roiPct: 0, confidence: 70, amountUsd: 100, notes: '' });

  useEffect(() => {
    if (status === 'authenticated') loadData();
  }, [status]);

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

  async function updateResult(id: string, result: 'correct' | 'incorrect', pnlUsd: number) {
    await fetch('/api/user/portfolio', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, result, pnlUsd }) });
    loadData();
  }

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

  const winRate = (portfolio?.winCount ?? 0) + (portfolio?.lossCount ?? 0) > 0
    ? Math.round(100 * (portfolio!.winCount) / (portfolio!.winCount + portfolio!.lossCount))
    : null;

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <header className="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/90 backdrop-blur-sm px-4 md:px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Portfolio Tracker</h1>
          <p className="text-xs text-gray-500">{session?.user?.email}</p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard" className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-xs hover:border-gray-500 hover:text-gray-300">← Dashboard</Link>
          <button onClick={() => setShowAdd(true)} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-500">+ Add Position</button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 space-y-6">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Total Invested', value: `$${(portfolio?.totalInvested ?? 0).toFixed(2)}`, color: 'text-blue-400' },
            { label: 'Total P&L',      value: `${(portfolio?.totalPnl ?? 0) >= 0 ? '+' : ''}$${(portfolio?.totalPnl ?? 0).toFixed(2)}`, color: (portfolio?.totalPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400' },
            { label: 'Win Rate',       value: winRate != null ? `${winRate}%` : '—', color: 'text-amber-400' },
            { label: 'Positions',      value: String(positions.length), color: 'text-gray-300' },
          ].map(c => (
            <div key={c.label} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
              <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
              <div className="text-xs text-gray-500 mt-1">{c.label}</div>
            </div>
          ))}
        </div>

        {/* Positions table */}
        {positions.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
            <div className="text-4xl mb-3">📊</div>
            <p className="text-gray-300 font-semibold">No positions tracked yet</p>
            <p className="text-gray-600 text-sm mt-1">Click &quot;Add Position&quot; to start tracking opportunities</p>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/60">
                  {['Opportunity', 'Type', 'ROI', 'Conf', 'Amount', 'Date', 'Result', 'P&L', ''].map(h => (
                    <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase first:pl-4">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {positions.map(p => (
                  <tr key={p.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3 max-w-xs">
                      <p className="text-gray-200 text-xs line-clamp-2">{p.title}</p>
                      {p.platformA && <p className="text-gray-600 text-xs">{p.platformA} → {p.platformB}</p>}
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-500 capitalize">{p.type.replace(/_/g,' ')}</td>
                    <td className="px-3 py-3 text-xs font-bold text-green-400">{p.roiPct.toFixed(1)}%</td>
                    <td className="px-3 py-3 text-xs text-gray-400">{p.confidence}%</td>
                    <td className="px-3 py-3 text-xs text-gray-300">${p.amountUsd.toFixed(0)}</td>
                    <td className="px-3 py-3 text-xs text-gray-600">{new Date(p.trackedAt).toLocaleDateString()}</td>
                    <td className="px-3 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${
                        p.result === 'correct'   ? 'border-green-700 bg-green-950/40 text-green-300' :
                        p.result === 'incorrect' ? 'border-red-700 bg-red-950/40 text-red-300' :
                        'border-gray-700 bg-gray-800 text-gray-500'
                      }`}>{p.result ?? 'open'}</span>
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {p.pnlUsd != null ? (
                        <span className={p.pnlUsd >= 0 ? 'text-green-400 font-semibold' : 'text-red-400 font-semibold'}>
                          {p.pnlUsd >= 0 ? '+' : ''}${p.pnlUsd.toFixed(2)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-3">
                      {(!p.result || p.result === 'open') && (
                        <div className="flex gap-1">
                          <button onClick={() => { const pnl = prompt('P&L in $:'); if (pnl) updateResult(p.id, 'correct', parseFloat(pnl)); }}
                            className="px-1.5 py-0.5 text-xs rounded border border-green-700 text-green-400 hover:bg-green-900/40">✓ Won</button>
                          <button onClick={() => { const pnl = prompt('Loss in $ (negative):'); if (pnl) updateResult(p.id, 'incorrect', parseFloat(pnl)); }}
                            className="px-1.5 py-0.5 text-xs rounded border border-red-700 text-red-400 hover:bg-red-900/40">✗ Lost</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
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
                <input placeholder="Platform A" value={addForm.platformA}
                  onChange={e => setAddForm(f => ({ ...f, platformA: e.target.value }))}
                  className="px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500" />
                <input placeholder="Platform B" value={addForm.platformB}
                  onChange={e => setAddForm(f => ({ ...f, platformB: e.target.value }))}
                  className="px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">ROI %</label>
                  <input type="number" step="0.1" value={addForm.roiPct}
                    onChange={e => setAddForm(f => ({ ...f, roiPct: parseFloat(e.target.value) }))}
                    className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Confidence %</label>
                  <input type="number" min={0} max={100} value={addForm.confidence}
                    onChange={e => setAddForm(f => ({ ...f, confidence: parseInt(e.target.value) }))}
                    className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Amount $</label>
                  <input type="number" step="1" value={addForm.amountUsd}
                    onChange={e => setAddForm(f => ({ ...f, amountUsd: parseFloat(e.target.value) }))}
                    className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
              </div>
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
