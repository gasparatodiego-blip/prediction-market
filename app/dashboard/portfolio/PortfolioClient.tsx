'use client';
import { useEffect, useState, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import SectionHelp from '@/app/components/SectionHelp';
import PlatformLogo from '@/components/PlatformLogo';

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
    <div className="rounded-card border border-line bg-surface p-4 font-body text-xs text-muted text-center py-6 shadow-card">
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
  const lineColor = last >= 0 ? '#0A9D6B' : '#D5552F';

  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-card">
      <div className="flex items-center justify-between mb-3">
        <span className="font-body text-xs font-semibold text-muted uppercase tracking-widest">CUMULATIVE P&amp;L</span>
        <span className={`font-mono text-sm font-bold tabular-nums ${last >= 0 ? 'text-mint-deep' : 'text-coral-ink'}`}>
          {last >= 0 ? '+' : ''}${last.toFixed(2)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none">
        {/* Zero baseline */}
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="#E3ECE7" strokeWidth="1" strokeDasharray="4,4" />
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
          <circle key={i} cx={x} cy={ys[i]} r="2.5" fill={points[i] >= 0 ? '#0A9D6B' : '#D5552F'} />
        ))}
      </svg>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="flex gap-1.5">
        {[0,1,2].map(i => (
          <div key={i} className="w-2 h-2 bg-mint rounded-full animate-bounce" style={{ animationDelay: `${i*0.15}s` }} />
        ))}
      </div>
    </div>
  );
}

export default function PortfolioClient() {
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
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="text-center">
        <p className="font-body text-ink-2 mb-4 text-sm">SIGN IN TO TRACK PORTFOLIO</p>
        <Link href="/auth/login" className="px-4 py-2 rounded-button border border-mint/40 bg-mint/10 text-mint font-body text-xs hover:bg-mint/20 transition-colors duration-100">
          SIGN IN
        </Link>
      </div>
    </div>
  );

  const summaryCards = [
    { label: 'TOTAL INVESTED',  value: `$${(portfolio?.totalInvested ?? 0).toFixed(2)}`, color: 'text-mint' },
    { label: 'REALISED P&L',    value: `${(portfolio?.totalPnl ?? 0) >= 0 ? '+' : ''}$${(portfolio?.totalPnl ?? 0).toFixed(2)}`, color: (portfolio?.totalPnl ?? 0) >= 0 ? 'text-mint-deep' : 'text-coral-ink' },
    { label: 'WIN RATE',        value: winRate != null ? `${winRate}%` : '—', color: 'text-gold' },
    { label: 'EXPECTED (OPEN)', value: `${stats.expectedPnl >= 0 ? '+' : ''}$${stats.expectedPnl.toFixed(2)}`, color: 'text-mint' },
  ];

  return (
    <main className="text-ink">
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 space-y-4">
        <SectionHelp section="portfolio" />
        <div className="flex items-center justify-end">
          <button onClick={() => setShowAdd(true)}
            className="px-3 py-1.5 rounded-button border border-mint/40 bg-mint/10 text-mint font-body text-xs hover:bg-mint/20 transition-colors duration-100">
            + POSITION
          </button>
        </div>
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {summaryCards.map(c => (
            <div key={c.label} className="rounded-card border border-line bg-surface p-4 shadow-card">
              <div className={`font-mono text-xl font-bold tabular-nums ${c.color}`}>{c.value}</div>
              <div className="font-body text-xs text-muted uppercase tracking-widest mt-1">{c.label}</div>
            </div>
          ))}
        </div>

        {/* Best trade banner */}
        {stats.bestTrade && (
          <div className="rounded-card border border-mint-deep/20 bg-surface px-4 py-3 flex items-center gap-3">
            <span className="text-mint-deep font-bold font-body text-xs uppercase tracking-widest shrink-0">BEST TRADE</span>
            <span className="text-ink-2 font-body text-xs truncate">{stats.bestTrade.title.slice(0, 60)}</span>
            <span className="ml-auto text-mint-deep font-bold font-mono tabular-nums text-sm shrink-0">
              +${(stats.bestTrade.pnlUsd ?? 0).toFixed(2)}
            </span>
          </div>
        )}

        {/* P&L Chart */}
        <PnlChart positions={positions} />

        {/* Positions table */}
        {positions.length === 0 ? (
          <div className="rounded-card border border-line bg-surface p-12 text-center shadow-card">
            <p className="font-body font-semibold text-ink-2 text-sm uppercase tracking-widest">NO POSITIONS TRACKED</p>
            <p className="font-body text-muted text-xs mt-2">Click &quot;+ POSITION&quot; to start tracking opportunities</p>
          </div>
        ) : (
          <div className="rounded-card border border-line overflow-x-auto shadow-card">
            <table className="w-full text-sm min-w-[700px]">
              <thead>
                <tr className="border-b border-line bg-surface text-muted text-xs font-body uppercase tracking-widest">
                  {['Opportunity', 'Type', 'Gross ROI', 'Net ROI', 'Amount', 'Exp. Profit', 'Date', 'Result', 'P&L', ''].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left font-semibold first:pl-4">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {positions.map(p => {
                  const gross = sanitizeRoi(p.roiPct);
                  const { netRoi, totalFeePct } = getNetRoi(gross, p.platformA, p.platformB);
                  const flagRoi = gross > 100 && p.type === 'prediction_market';
                  const expProfit = p.amountUsd * (netRoi / 100) * (p.confidence / 100);
                  return (
                    <tr key={p.id} className="hover:bg-bg-soft/40 transition-colors duration-75">
                      <td className="px-4 py-2.5 max-w-[180px]">
                        <p className="text-ink text-xs line-clamp-2">{p.title}</p>
                        {p.platformA && (
                          <p className="text-muted text-xs font-mono mt-0.5 inline-flex items-center gap-1">
                            <PlatformLogo platform={p.platformA} size={11} />
                            {p.platformA}
                            {p.platformB && <> → <PlatformLogo platform={p.platformB} size={11} />{p.platformB}</>}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-xs px-1.5 py-0.5 rounded-sm border border-line bg-bg-soft font-body uppercase tracking-wide text-ink-2">
                          {p.type.replace(/_/g,' ')}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        <span className={`font-bold font-mono tabular-nums ${flagRoi ? 'text-gold' : 'text-mint-deep'}`}>
                          {gross.toFixed(1)}%
                        </span>
                        {flagRoi && <span className="ml-1 text-gold text-xs" title="ROI >100% — verify manually">⚠</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        <span className={`font-bold font-mono tabular-nums ${netRoi >= 0 ? 'text-mint' : 'text-coral-ink'}`}>
                          {netRoi.toFixed(1)}%
                        </span>
                        {totalFeePct > 0 && <span className="text-muted font-mono ml-1">(-{totalFeePct}%)</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs font-mono tabular-nums text-ink">${p.amountUsd.toFixed(0)}</td>
                      <td className="px-3 py-2.5 text-xs font-mono tabular-nums">
                        <span className={expProfit >= 0 ? 'text-mint' : 'text-coral-ink'}>
                          {expProfit >= 0 ? '+' : ''}${expProfit.toFixed(2)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted font-mono tabular-nums whitespace-nowrap">
                        {new Date(p.trackedAt).toLocaleDateString()}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`text-xs px-1.5 py-0.5 rounded-sm border font-body uppercase tracking-wide ${
                          p.result === 'correct'   ? 'border-mint-deep/40 bg-mint-tint text-mint-deep' :
                          p.result === 'incorrect' ? 'border-coral-ink/40 bg-coral-tint text-coral-ink' :
                          'border-line bg-bg-soft text-muted'
                        }`}>{p.result ?? 'open'}</span>
                      </td>
                      <td className="px-3 py-2.5 text-xs font-mono tabular-nums">
                        {p.pnlUsd != null ? (
                          <span className={p.pnlUsd >= 0 ? 'text-mint-deep font-semibold' : 'text-coral-ink font-semibold'}>
                            {p.pnlUsd >= 0 ? '+' : ''}${p.pnlUsd.toFixed(2)}
                          </span>
                        ) : <span className="text-muted">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {(!p.result || p.result === 'open') && (
                          <div className="flex gap-1">
                            <button onClick={() => updateResult(p.id, 'correct')}
                              className="px-1.5 py-0.5 text-xs rounded-sm border border-mint-deep/40 text-mint-deep hover:bg-mint-tint font-body transition-colors duration-100">✓</button>
                            <button onClick={() => updateResult(p.id, 'incorrect')}
                              className="px-1.5 py-0.5 text-xs rounded-sm border border-coral-ink/40 text-coral-ink hover:bg-coral-tint font-body transition-colors duration-100">✗</button>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/70 backdrop-blur-sm" onClick={() => setShowAdd(false)}>
          <div className="bg-surface border border-line rounded-card shadow-card p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <h3 className="font-display font-semibold text-sm text-ink uppercase tracking-widest mb-4">TRACK OPPORTUNITY</h3>
            <form onSubmit={addPosition} className="space-y-3">
              <input required placeholder="Opportunity title" value={addForm.title}
                onChange={e => setAddForm(f => ({ ...f, title: e.target.value }))}
                className="w-full px-3 py-2 rounded-button bg-surface border border-line text-ink text-sm font-body focus:outline-none focus:border-mint/60 placeholder:text-muted" />
              <div className="grid grid-cols-2 gap-2">
                <select value={addForm.type} onChange={e => setAddForm(f => ({ ...f, type: e.target.value }))}
                  className="col-span-2 px-3 py-2 rounded-button bg-surface border border-line text-ink text-xs font-body focus:outline-none focus:border-mint/60">
                  <option value="prediction_market">Prediction Market Arb</option>
                  <option value="funding_rate">Funding Rate</option>
                  <option value="cex_arb">CEX Arb</option>
                  <option value="sports_arb">Sports Arb</option>
                  <option value="cash_carry">Cash &amp; Carry</option>
                </select>
                <input placeholder="Platform A (e.g. kalshi)" value={addForm.platformA}
                  onChange={e => setAddForm(f => ({ ...f, platformA: e.target.value }))}
                  className="px-3 py-2 rounded-button bg-surface border border-line text-ink text-sm font-body focus:outline-none focus:border-mint/60 placeholder:text-muted" />
                <input placeholder="Platform B (optional)" value={addForm.platformB}
                  onChange={e => setAddForm(f => ({ ...f, platformB: e.target.value }))}
                  className="px-3 py-2 rounded-button bg-surface border border-line text-ink text-sm font-body focus:outline-none focus:border-mint/60 placeholder:text-muted" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'ROI %',     key: 'roiPct',     type: 'number', step: '0.1' },
                  { label: 'CONF %',    key: 'confidence', type: 'number', min: 0, max: 100 },
                  { label: 'AMOUNT $',  key: 'amountUsd',  type: 'number', step: '1' },
                ].map(f => (
                  <div key={f.key}>
                    <label className="font-body text-xs text-muted uppercase tracking-widest mb-1 block">{f.label}</label>
                    <input type={f.type} step={(f as any).step} min={(f as any).min} max={(f as any).max}
                      value={(addForm as any)[f.key]}
                      onChange={e => setAddForm(prev => ({ ...prev, [f.key]: parseFloat(e.target.value) }))}
                      className="w-full px-3 py-2 rounded-button bg-surface border border-line text-ink text-sm font-mono tabular-nums focus:outline-none focus:border-mint/60" />
                  </div>
                ))}
              </div>
              {addForm.platformA && (
                <div className="font-body text-xs text-muted bg-bg-soft border border-line rounded-card px-3 py-2">
                  {(() => {
                    const { netRoi, totalFeePct } = getNetRoi(addForm.roiPct, addForm.platformA, addForm.platformB);
                    return `Net ROI after fees: ${netRoi.toFixed(1)}% (−${totalFeePct}%) → Expected: $${(addForm.amountUsd * netRoi / 100 * addForm.confidence / 100).toFixed(2)}`;
                  })()}
                </div>
              )}
              <textarea placeholder="Notes (optional)" value={addForm.notes}
                onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))}
                rows={2}
                className="w-full px-3 py-2 rounded-button bg-surface border border-line text-ink text-sm font-body focus:outline-none focus:border-mint/60 resize-none placeholder:text-muted" />
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => setShowAdd(false)}
                  className="flex-1 py-2 rounded-button border border-line text-ink-2 font-body text-xs hover:border-mint/30 hover:text-ink transition-colors duration-100">
                  CANCEL
                </button>
                <button type="submit"
                  className="flex-1 py-2 rounded-button border border-mint/40 bg-mint/10 text-mint font-body text-xs hover:bg-mint/20 transition-colors duration-100">
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
