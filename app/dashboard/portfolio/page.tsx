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

function PnlChart({ positions }: { positions: Position[] }) {
  const resolved = positions
    .filter(p => p.result !== 'open' && p.pnlUsd != null)
    .sort((a, b) => new Date(a.trackedAt).getTime() - new Date(b.trackedAt).getTime());

  if (resolved.length < 2) return (
    <div className="rounded border border-border bg-bg-panel p-4 text-xs text-text-muted font-mono text-center py-6">
      RESOLVE 2+ POSITIONS TO SEE P&amp;L CHART
    </div>
  );

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
  const lineColor = last >= 0 ? '#22C55E' : '#EF4444';

  return (
    <div className="rounded border border-border bg-bg-panel p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-text-muted font-mono uppercase tracking-widest">CUMULATIVE P&amp;L</span>
        <span className={`text-sm font-bold font-mono tabular-nums ${last >= 0 ? 'text-positive' : 'text-negative'}`}>
          {last >= 0 ? '+' : ''}${last.toFixed(2)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none">
        {/* Zero baseline */}
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="#232834" strokeWidth="1" strokeDasharray="4,4" />
        {/* P&L area fill */}
        <path
          d={`${path} L${xs[xs.length-1]},${zeroY} L${xs[0]},${zeroY} Z`}
          fill={lineColor}
          fillOpacity="0.08"
        />
        {/* P&L line */}
        <path d={path} fill="none" stroke={lineColor} strokeWidth="1.5" />
        {/* Data points */}
        {xs.map((x, i) => (
          <circle key={i} cx={x} cy={ys[i]} r="2.5" fill={points[i] >= 0 ? '#22C55E' : '#EF4444'} />
        ))}
      </svg>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="min-h-screen bg-bg-base flex items-center justify-center">
      <div className="flex gap-1.5">
        {[0,1,2].map(i => (
          <div key={i} className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: `${i*0.15}s` }} />
        ))}
      </div>
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

  if (status === 'loading' || loading) return <LoadingSpinner />;

  if (status === 'unauthenticated') return (
    <div className="min-h-screen bg-bg-base flex items-center justify-center">
      <div className="text-center">
        <p className="text-text-secondary mb-4 font-mono text-sm">SIGN IN TO TRACK PORTFOLIO</p>
        <Link href="/auth/login" className="px-4 py-2 rounded border border-accent/40 bg-accent/10 text-accent text-xs font-mono hover:bg-accent/20 transition-colors duration-100">
          SIGN IN
        </Link>
      </div>
    </div>
  );

  const summaryCards = [
    { label: 'TOTAL INVESTED',  value: `$${(portfolio?.totalInvested ?? 0).toFixed(2)}`, color: 'text-accent-bright' },
    { label: 'REALISED P&L',    value: `${(portfolio?.totalPnl ?? 0) >= 0 ? '+' : ''}$${(portfolio?.totalPnl ?? 0).toFixed(2)}`, color: (portfolio?.totalPnl ?? 0) >= 0 ? 'text-positive' : 'text-negative' },
    { label: 'WIN RATE',        value: winRate != null ? `${winRate}%` : '—', color: 'text-warning' },
    { label: 'EXPECTED (OPEN)', value: `${stats.expectedPnl >= 0 ? '+' : ''}$${stats.expectedPnl.toFixed(2)}`, color: 'text-accent' },
  ];

  return (
    <main className="min-h-screen bg-bg-base text-text-primary">
      <header className="sticky top-0 z-10 border-b border-border bg-bg-panel/90 backdrop-blur-sm px-4 md:px-6 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-sm font-semibold font-mono uppercase tracking-widest text-text-primary">PORTFOLIO TRACKER</h1>
          <p className="text-xs text-text-muted font-mono">{session?.user?.email}</p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/history"
            className="px-3 py-1.5 rounded border border-border text-text-secondary text-xs font-mono hover:border-accent/30 hover:text-text-primary transition-colors duration-100">
            HISTORY
          </Link>
          <Link href="/dashboard"
            className="px-3 py-1.5 rounded border border-border text-text-secondary text-xs font-mono hover:border-accent/30 hover:text-text-primary transition-colors duration-100">
            ← DASHBOARD
          </Link>
          <button onClick={() => setShowAdd(true)}
            className="px-3 py-1.5 rounded border border-accent/40 bg-accent/10 text-accent text-xs font-mono hover:bg-accent/20 transition-colors duration-100">
            + POSITION
          </button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 space-y-4">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {summaryCards.map(c => (
            <div key={c.label} className="rounded border border-border bg-bg-panel p-4">
              <div className={`text-xl font-bold font-mono tabular-nums ${c.color}`}>{c.value}</div>
              <div className="text-xs text-text-muted font-mono uppercase tracking-widest mt-1">{c.label}</div>
            </div>
          ))}
        </div>

        {/* Best trade banner */}
        {stats.bestTrade && (
          <div className="rounded border border-positive/20 bg-bg-panel px-4 py-3 flex items-center gap-3">
            <span className="text-positive font-bold text-xs font-mono uppercase tracking-widest shrink-0">BEST TRADE</span>
            <span className="text-text-secondary text-xs font-mono truncate">{stats.bestTrade.title.slice(0, 60)}</span>
            <span className="ml-auto text-positive font-bold font-mono tabular-nums text-sm shrink-0">
              +${(stats.bestTrade.pnlUsd ?? 0).toFixed(2)}
            </span>
          </div>
        )}

        {/* P&L Chart */}
        <PnlChart positions={positions} />

        {/* Positions table */}
        {positions.length === 0 ? (
          <div className="rounded border border-border bg-bg-panel p-12 text-center">
            <p className="text-text-secondary font-semibold font-mono text-sm uppercase tracking-widest">NO POSITIONS TRACKED</p>
            <p className="text-text-muted text-xs font-mono mt-2">Click &quot;+ POSITION&quot; to start tracking opportunities</p>
          </div>
        ) : (
          <div className="rounded border border-border overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead>
                <tr className="border-b border-border bg-bg-panel text-text-muted text-xs font-mono uppercase tracking-widest">
                  {['Opportunity', 'Type', 'Gross ROI', 'Net ROI', 'Amount', 'Exp. Profit', 'Date', 'Result', 'P&L', ''].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left font-semibold first:pl-4">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {positions.map(p => {
                  const gross = sanitizeRoi(p.roiPct);
                  const { netRoi, totalFeePct } = getNetRoi(gross, p.platformA, p.platformB);
                  const flagRoi = gross > 100 && p.type === 'prediction_market';
                  const expProfit = p.amountUsd * (netRoi / 100) * (p.confidence / 100);
                  return (
                    <tr key={p.id} className="hover:bg-bg-elevated/40 transition-colors duration-75">
                      <td className="px-4 py-2.5 max-w-[180px]">
                        <p className="text-text-primary text-xs line-clamp-2">{p.title}</p>
                        {p.platformA && (
                          <p className="text-text-muted text-xs font-mono mt-0.5">
                            {p.platformA}{p.platformB ? ` → ${p.platformB}` : ''}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-xs px-1.5 py-0.5 rounded border border-border bg-bg-elevated font-mono uppercase tracking-wide text-text-secondary">
                          {p.type.replace(/_/g,' ')}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        <span className={`font-bold font-mono tabular-nums ${flagRoi ? 'text-warning' : 'text-positive'}`}>
                          {gross.toFixed(1)}%
                        </span>
                        {flagRoi && <span className="ml-1 text-warning text-xs" title="ROI >100% — verify manually">⚠</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        <span className={`font-bold font-mono tabular-nums ${netRoi >= 0 ? 'text-accent-bright' : 'text-negative'}`}>
                          {netRoi.toFixed(1)}%
                        </span>
                        {totalFeePct > 0 && <span className="text-text-muted font-mono ml-1">(-{totalFeePct}%)</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs font-mono tabular-nums text-text-primary">${p.amountUsd.toFixed(0)}</td>
                      <td className="px-3 py-2.5 text-xs font-mono tabular-nums">
                        <span className={expProfit >= 0 ? 'text-accent' : 'text-negative'}>
                          {expProfit >= 0 ? '+' : ''}${expProfit.toFixed(2)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-text-muted font-mono tabular-nums whitespace-nowrap">
                        {new Date(p.trackedAt).toLocaleDateString()}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`text-xs px-1.5 py-0.5 rounded border font-mono uppercase tracking-wide ${
                          p.result === 'correct'   ? 'border-positive/40 bg-positive/10 text-positive' :
                          p.result === 'incorrect' ? 'border-negative/40 bg-negative/10 text-negative' :
                          'border-border bg-bg-elevated text-text-muted'
                        }`}>{p.result ?? 'open'}</span>
                      </td>
                      <td className="px-3 py-2.5 text-xs font-mono tabular-nums">
                        {p.pnlUsd != null ? (
                          <span className={p.pnlUsd >= 0 ? 'text-positive font-semibold' : 'text-negative font-semibold'}>
                            {p.pnlUsd >= 0 ? '+' : ''}${p.pnlUsd.toFixed(2)}
                          </span>
                        ) : <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {(!p.result || p.result === 'open') && (
                          <div className="flex gap-1">
                            <button onClick={() => updateResult(p.id, 'correct')}
                              className="px-1.5 py-0.5 text-xs rounded border border-positive/40 text-positive hover:bg-positive/10 font-mono transition-colors duration-100">✓</button>
                            <button onClick={() => updateResult(p.id, 'incorrect')}
                              className="px-1.5 py-0.5 text-xs rounded border border-negative/40 text-negative hover:bg-negative/10 font-mono transition-colors duration-100">✗</button>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-bg-base/80 backdrop-blur-sm" onClick={() => setShowAdd(false)}>
          <div className="bg-bg-elevated border border-border rounded p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-sm text-text-primary font-mono uppercase tracking-widest mb-4">TRACK OPPORTUNITY</h3>
            <form onSubmit={addPosition} className="space-y-3">
              <input required placeholder="Opportunity title" value={addForm.title}
                onChange={e => setAddForm(f => ({ ...f, title: e.target.value }))}
                className="w-full px-3 py-2 rounded bg-bg-panel border border-border text-text-primary text-sm font-mono focus:outline-none focus:border-accent/60 placeholder:text-text-muted" />
              <div className="grid grid-cols-2 gap-2">
                <select value={addForm.type} onChange={e => setAddForm(f => ({ ...f, type: e.target.value }))}
                  className="col-span-2 px-3 py-2 rounded bg-bg-panel border border-border text-text-primary text-xs font-mono focus:outline-none focus:border-accent/60">
                  <option value="prediction_market">Prediction Market Arb</option>
                  <option value="funding_rate">Funding Rate</option>
                  <option value="cex_arb">CEX Arb</option>
                  <option value="sports_arb">Sports Arb</option>
                  <option value="cash_carry">Cash &amp; Carry</option>
                </select>
                <input placeholder="Platform A (e.g. kalshi)" value={addForm.platformA}
                  onChange={e => setAddForm(f => ({ ...f, platformA: e.target.value }))}
                  className="px-3 py-2 rounded bg-bg-panel border border-border text-text-primary text-sm font-mono focus:outline-none focus:border-accent/60 placeholder:text-text-muted" />
                <input placeholder="Platform B (optional)" value={addForm.platformB}
                  onChange={e => setAddForm(f => ({ ...f, platformB: e.target.value }))}
                  className="px-3 py-2 rounded bg-bg-panel border border-border text-text-primary text-sm font-mono focus:outline-none focus:border-accent/60 placeholder:text-text-muted" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'ROI %',     key: 'roiPct',     type: 'number', step: '0.1' },
                  { label: 'CONF %',    key: 'confidence', type: 'number', min: 0, max: 100 },
                  { label: 'AMOUNT $',  key: 'amountUsd',  type: 'number', step: '1' },
                ].map(f => (
                  <div key={f.key}>
                    <label className="text-xs text-text-muted font-mono uppercase tracking-widest mb-1 block">{f.label}</label>
                    <input type={f.type} step={(f as any).step} min={(f as any).min} max={(f as any).max}
                      value={(addForm as any)[f.key]}
                      onChange={e => setAddForm(prev => ({ ...prev, [f.key]: parseFloat(e.target.value) }))}
                      className="w-full px-3 py-2 rounded bg-bg-panel border border-border text-text-primary text-sm font-mono tabular-nums focus:outline-none focus:border-accent/60" />
                  </div>
                ))}
              </div>
              {addForm.platformA && (
                <div className="text-xs text-text-muted font-mono bg-bg-panel border border-border rounded px-3 py-2">
                  {(() => {
                    const { netRoi, totalFeePct } = getNetRoi(addForm.roiPct, addForm.platformA, addForm.platformB);
                    return `Net ROI after fees: ${netRoi.toFixed(1)}% (−${totalFeePct}%) → Expected: $${(addForm.amountUsd * netRoi / 100 * addForm.confidence / 100).toFixed(2)}`;
                  })()}
                </div>
              )}
              <textarea placeholder="Notes (optional)" value={addForm.notes}
                onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))}
                rows={2}
                className="w-full px-3 py-2 rounded bg-bg-panel border border-border text-text-primary text-sm font-mono focus:outline-none focus:border-accent/60 resize-none placeholder:text-text-muted" />
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowAdd(false)}
                  className="flex-1 py-2 rounded border border-border text-text-secondary text-xs font-mono hover:border-accent/30 hover:text-text-primary transition-colors duration-100">
                  CANCEL
                </button>
                <button type="submit"
                  className="flex-1 py-2 rounded border border-accent/40 bg-accent/10 text-accent text-xs font-mono hover:bg-accent/20 transition-colors duration-100">
                  TRACK IT
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
