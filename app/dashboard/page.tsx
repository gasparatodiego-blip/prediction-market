'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useSession, signOut } from 'next-auth/react';
import Link from 'next/link';
import type { MarketsResponse, PanelMarket, ArbCandidate } from '@/app/api/markets/route';
import type { CryptoResponse, ExchangePrice, CryptoMarket, CexArbOpp, FuturesInfo, BasisTrade, HighFunding, DexPrice } from '@/app/api/crypto/route';
import type { SportsResponse, SportsMarket } from '@/app/api/sports/route';
import type { WeatherResponse, WeatherMarket, CityForecast } from '@/app/api/weather/route';
import type { MmResponse, MmOpp } from '@/app/api/marketmaker/route';
import type { LpResponse, LpPosition, LpMarket } from '@/app/api/liquidity/route';

// ── Platform config ───────────────────────────────

const PLATFORMS = {
  predictit:      { label: 'PredictIt',   dotClass: 'bg-green-400',  headerClass: 'text-green-400',  borderClass: 'border-green-900/40',  bgClass: 'bg-green-950/20',  badgeClass: 'bg-green-900/60 border-green-700 text-green-300' },
  manifold:       { label: 'Manifold',    dotClass: 'bg-blue-400',   headerClass: 'text-blue-400',   borderClass: 'border-blue-900/40',   bgClass: 'bg-blue-950/20',   badgeClass: 'bg-blue-900/60 border-blue-700 text-blue-300' },
  kalshi:         { label: 'Kalshi',      dotClass: 'bg-yellow-400', headerClass: 'text-yellow-400', borderClass: 'border-yellow-900/40', bgClass: 'bg-yellow-950/20', badgeClass: 'bg-yellow-900/60 border-yellow-700 text-yellow-300' },
  polymarket:     { label: 'Polymarket',  dotClass: 'bg-purple-400', headerClass: 'text-purple-400', borderClass: 'border-purple-900/40', bgClass: 'bg-purple-950/20', badgeClass: 'bg-purple-900/60 border-purple-700 text-purple-300' },
  betfair:        { label: 'Betfair',     dotClass: 'bg-orange-400', headerClass: 'text-orange-400', borderClass: 'border-orange-900/40', bgClass: 'bg-orange-950/20', badgeClass: 'bg-orange-900/60 border-orange-700 text-orange-300' },
  metaculus:      { label: 'Metaculus',   dotClass: 'bg-teal-400',   headerClass: 'text-teal-400',   borderClass: 'border-teal-900/40',   bgClass: 'bg-teal-950/20',   badgeClass: 'bg-teal-900/60 border-teal-700 text-teal-300' },
  augur:          { label: 'Augur',       dotClass: 'bg-rose-400',   headerClass: 'text-rose-400',   borderClass: 'border-rose-900/40',   bgClass: 'bg-rose-950/20',   badgeClass: 'bg-rose-900/60 border-rose-700 text-rose-300' },
  oddsapi:        { label: 'Odds API',    dotClass: 'bg-sky-400',    headerClass: 'text-sky-400',    borderClass: 'border-sky-900/40',    bgClass: 'bg-sky-950/20',    badgeClass: 'bg-sky-900/60 border-sky-700 text-sky-300' },
  opinionmarkets: { label: 'Opinion Mkt', dotClass: 'bg-pink-400',   headerClass: 'text-pink-400',   borderClass: 'border-pink-900/40',   bgClass: 'bg-pink-950/20',   badgeClass: 'bg-pink-900/60 border-pink-700 text-pink-300' },
} as const;
type PlatformKey = keyof typeof PLATFORMS;

// ── Master opp type ───────────────────────────────

interface MasterOpp {
  id: string; source: string; type: string; title: string; description: string;
  platform_a?: string; price_a?: number; platform_b?: string; price_b?: number;
  spread_pct?: number; roi: number; expected_return?: string;
  profit_on_1000?: number; fees_estimate?: number; net_profit?: number;
  confidence: number; urgency: 'low' | 'medium' | 'high';
  action?: string; expiry_hours?: number; risk?: string; reasoning?: string;
  timestamp: string;
}

type OppTypeFilter = 'all' | 'prediction_market' | 'funding_rate' | 'sports_arb' | 'info_lag' | 'cex_arb' | 'cash_carry';

interface ArbitrageOpp {
  question: string; lowMarket: ArbCandidate; highMarket: ArbCandidate;
  spread: number; roi: number; earnPer100: number;
  expiresAt: number | null; gapAge: number | null; biasScore: number | null;
}

// ── Stats type ────────────────────────────────────

interface StatsData {
  charts: { labels: string[]; oppsByDay: number[]; confByDay: number[] };
  stats: { totalScans: number; totalOpps: number; avgConfAll: number; totalAlerts: number; bestConf: number; currentBestRoi: number };
}

// ── Helpers ───────────────────────────────────────

const H = 3_600_000;

function timeAgo(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function fmtDollars(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

function urgencyBadge(u: string) {
  if (u === 'high')   return 'border-red-700 bg-red-900/60 text-red-300';
  if (u === 'medium') return 'border-amber-700 bg-amber-900/50 text-amber-300';
  return 'border-gray-700 bg-gray-800 text-gray-400';
}

function riskColor(r?: string) {
  if (r === 'low')    return 'text-green-400';
  if (r === 'medium') return 'text-amber-400';
  return 'text-red-400';
}

function typeLabel(t: string) {
  return ({ prediction_market: 'Prediction Arb', funding_rate: 'Funding Rate', sports_arb: 'Sports Arb', info_lag: 'Info Lag', cex_arb: 'CEX Arb', cash_carry: 'Cash & Carry' } as Record<string, string>)[t] ?? t.replace(/_/g, ' ');
}
function typeIcon(t: string) {
  return ({ prediction_market: '🔮', funding_rate: '⚡', sports_arb: '🏟️', info_lag: '⚠️', cex_arb: '💱', cash_carry: '⚖️' } as Record<string, string>)[t] ?? '📊';
}

function expiryLabel(ms: number | null | undefined) {
  if (!ms) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return 'Expired';
  const h = diff / H;
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── Live arb detection ────────────────────────────

const STOPWORDS = new Set(['will','would','could','should','their','there','these','those','which','about','after','before','with','from','have','been','that','this','when','what','where','who','the','and','for','are','but','not','all','can','was','one','its','over','under','more','first','last','next']);
function kw(text: string) { return new Set(text.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w))); }
function jaccard(a: string, b: string) { const ka = kw(a), kb = kw(b); let i = 0; ka.forEach(w => { if (kb.has(w)) i++; }); const u = ka.size + kb.size - i; return u > 0 ? i / u : 0; }

function detectArbitrage(candidates: ArbCandidate[]): ArbitrageOpp[] {
  const seen = new Set<string>(); const results: ArbitrageOpp[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      const sameSource = a.platform === b.platform && (a.platform !== 'oddsapi' || !a.bookmaker || !b.bookmaker || a.bookmaker === b.bookmaker);
      if (sameSource) continue;
      if (jaccard(a.question, b.question) < 0.25) continue;
      const spread = Math.abs(a.probability - b.probability);
      if (spread < 3) continue;
      const low = a.probability <= b.probability ? a : b;
      const high = a.probability > b.probability ? a : b;
      const roi = low.probability > 0 ? (spread / low.probability) * 100 : 0;
      if (roi > 200) continue;
      const key = `${low.platform}:${high.platform}:${low.probability}:${high.probability}:${high.question.slice(0,30)}`;
      if (seen.has(key)) continue; seen.add(key);
      const priceTimes = [low.priceSeenAt, high.priceSeenAt].filter((t): t is number => t != null);
      const gapAge = priceTimes.length ? Date.now() - Math.max(...priceTimes) : null;
      const expiries = [low.expiresAt, high.expiresAt].filter((e): e is number => e != null);
      results.push({ question: high.question, lowMarket: low, highMarket: high, spread, roi, earnPer100: Math.round((roi / 100) * 100 * 10) / 10, expiresAt: expiries.length ? Math.min(...expiries) : null, gapAge, biasScore: low.biasScore ?? null });
    }
  }
  return results.sort((a, b) => b.roi - a.roi).slice(0, 8);
}

function kellyFraction(low: number, high: number) {
  const edge = (high - low) / 100, odds = (100 / low) - 1;
  if (odds <= 0) return 0; return Math.max(0, Math.min(edge / odds, 0.25));
}

// ── Sparkline ─────────────────────────────────────

function Sparkline({ data, color = '#22c55e', height = 48 }: { data: number[]; color?: string; height?: number }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * 200;
    const y = height - (v / max) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 200 ${height}`} style={{ width: '100%', height }} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── Modal ─────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg text-white leading-snug pr-4">{title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-2xl leading-none flex-shrink-0">&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Master opportunity card ───────────────────────

const FEES_CLIENT: Record<string, number> = {
  kalshi: 0.07, polymarket: 0.02, manifold: 0, metaculus: 0,
  predictit: 0.15, betfair: 0.05, augur: 0.01, gnosis: 0.02, futuur: 0.02, goodjudgment: 0,
};
function sanitizeRoi(v: number) { return Math.min(500, Math.max(-100, isFinite(v) ? v : 0)); }
function netRoiAfterFees(gross: number, pA?: string, pB?: string) {
  const fA = FEES_CLIENT[pA?.toLowerCase() ?? ''] ?? 0;
  const fB = FEES_CLIENT[pB?.toLowerCase() ?? ''] ?? 0;
  return +(gross * (1 - fA - fB)).toFixed(2);
}

function MasterOppCard({ opp, bankroll }: { opp: MasterOpp; bankroll: number }) {
  const [showModal, setShowModal] = useState(false);
  const rawRoi       = sanitizeRoi(opp.roi);
  const flagRoi      = rawRoi > 100 && (opp.type === 'prediction_market' || opp.type === 'cross_platform');
  const netRoi       = netRoiAfterFees(rawRoi, opp.platform_a, opp.platform_b);
  const profitBase   = opp.net_profit ?? opp.profit_on_1000 ?? null;
  const profitScaled = profitBase != null ? Math.round((bankroll / 1000) * Math.min(profitBase, 5000)) : null;

  return (
    <>
      <div className={`rounded-xl border bg-gray-900/60 hover:border-gray-600 transition-all p-5 ${
        opp.urgency === 'high' ? 'border-red-900/60' : opp.urgency === 'medium' ? 'border-amber-900/40' : 'border-gray-800'
      }`}>
        <div className="flex items-start gap-4">
          {/* Left badges */}
          <div className="flex-shrink-0 space-y-1.5 min-w-[82px]">
            <div className={`rounded-xl border px-3 py-2 text-center ${
              rawRoi >= 10 ? 'border-green-700 bg-green-900/40' : rawRoi >= 3 ? 'border-amber-700 bg-amber-900/30' : 'border-blue-800 bg-blue-950/30'
            }`}>
              <div className={`text-xl font-bold leading-none ${rawRoi >= 10 ? 'text-green-400' : rawRoi >= 3 ? 'text-amber-400' : 'text-blue-400'}`}>
                {opp.expected_return ?? `+${rawRoi.toFixed(1)}%`}
                {flagRoi && <span className="text-yellow-500 text-xs ml-0.5">⚠</span>}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {netRoi !== rawRoi ? `net ${netRoi.toFixed(1)}%` : 'return'}
              </div>
            </div>
            <div className={`text-xs font-bold px-2 py-1 rounded-full border text-center ${urgencyBadge(opp.urgency)}`}>
              {opp.urgency.toUpperCase()}
            </div>
          </div>

          <div className="flex-1 min-w-0">
            {/* Title */}
            <div className="flex items-start gap-2 mb-2 flex-wrap">
              <span className="text-sm">{typeIcon(opp.type)}</span>
              <p className="text-sm font-bold text-gray-100 leading-snug flex-1">{opp.title}</p>
              <span className="flex-shrink-0 text-xs px-2 py-0.5 rounded-full border border-gray-700 text-gray-500">{typeLabel(opp.type)}</span>
            </div>

            <p className="text-xs text-gray-400 mb-3 leading-relaxed">{opp.description}</p>

            {/* Platform price comparison */}
            {opp.platform_a && opp.platform_b && opp.price_a != null && opp.price_b != null && (
              <div className="flex items-center gap-2 flex-wrap mb-3">
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-xs">
                  <span className="text-gray-400">{opp.platform_a}</span>
                  <span className="text-sm font-bold text-red-400">{opp.price_a}¢</span>
                </div>
                <span className="text-gray-600 text-xs">→ buy low, sell high →</span>
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-xs">
                  <span className="text-gray-400">{opp.platform_b}</span>
                  <span className="text-sm font-bold text-green-400">{opp.price_b}¢</span>
                </div>
                {opp.spread_pct != null && (
                  <span className="text-xs px-2 py-1 rounded-full border border-green-800 bg-green-950/40 text-green-400 font-semibold">+{opp.spread_pct}¢</span>
                )}
              </div>
            )}

            {/* Profit + confidence row */}
            <div className="flex items-center gap-3 flex-wrap mb-3">
              {profitScaled != null && (
                <div className="px-3 py-1.5 rounded-lg bg-gray-800/60 border border-gray-700 text-xs">
                  <span className="text-gray-500">Invest ${bankroll.toLocaleString()} → earn </span>
                  <span className="text-green-400 font-bold">${profitScaled}</span>
                  {opp.fees_estimate != null && <span className="text-gray-600"> (fees ~${Math.round((bankroll/1000)*opp.fees_estimate)})</span>}
                </div>
              )}
              <div className="flex items-center gap-1.5 flex-1 max-w-[140px]">
                <span className="text-xs text-gray-600 whitespace-nowrap">Conf:</span>
                <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${opp.confidence >= 80 ? 'bg-green-500' : opp.confidence >= 60 ? 'bg-amber-500' : 'bg-gray-500'}`}
                    style={{ width: `${opp.confidence}%` }} />
                </div>
                <span className={`text-xs font-bold ${opp.confidence >= 80 ? 'text-green-400' : opp.confidence >= 60 ? 'text-amber-400' : 'text-gray-400'}`}>{opp.confidence}%</span>
              </div>
              {opp.risk && <span className={`text-xs font-semibold ${riskColor(opp.risk)}`}>risk: {opp.risk}</span>}
              {opp.expiry_hours != null && <span className="text-xs text-gray-600">⏱ {opp.expiry_hours}h</span>}
            </div>

            {opp.reasoning && <p className="text-xs text-gray-600 italic mb-3 line-clamp-1">{opp.reasoning}</p>}

            {opp.action && (
              <button onClick={() => setShowModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-800 bg-blue-950/40 text-blue-400 text-xs font-semibold hover:border-blue-600 hover:text-blue-300 transition-colors">
                How to execute this →
              </button>
            )}
          </div>
        </div>
      </div>

      {showModal && (
        <Modal title={opp.title} onClose={() => setShowModal(false)}>
          <div className="space-y-4">
            <div className="flex gap-2 flex-wrap">
              <span className={`text-xs px-2 py-0.5 rounded-full border ${urgencyBadge(opp.urgency)}`}>{opp.urgency.toUpperCase()}</span>
              <span className="text-xs px-2 py-0.5 rounded-full border border-gray-700 text-gray-400">{typeLabel(opp.type)}</span>
              <span className={`text-xs ${riskColor(opp.risk)}`}>risk: {opp.risk}</span>
            </div>
            <p className="text-sm text-gray-300">{opp.description}</p>
            {opp.platform_a && opp.platform_b && (
              <div className="p-3 rounded-lg bg-gray-800 border border-gray-700 text-sm">
                <div className="text-xs text-gray-500 mb-1">Price gap</div>
                <span className="text-red-400 font-bold">{opp.platform_a} {opp.price_a}¢</span>
                <span className="text-gray-500 mx-2">→</span>
                <span className="text-green-400 font-bold">{opp.platform_b} {opp.price_b}¢</span>
                {opp.spread_pct != null && <span className="text-gray-400 ml-2">(+{opp.spread_pct}¢ spread)</span>}
              </div>
            )}
            {opp.action && (
              <div>
                <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Execution steps</div>
                <div className="space-y-2">
                  {opp.action.split(/\n|(?=\d\.)/).filter(s => s.trim()).map((step, i) => (
                    <div key={i} className="flex gap-2 text-sm">
                      <span className="text-blue-400 font-mono text-xs mt-0.5 shrink-0">{i + 1}.</span>
                      <p className="text-gray-300">{step.replace(/^\d+\.\s*/, '')}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {opp.reasoning && (
              <div className="p-3 rounded-lg bg-gray-800/50 border border-gray-700/50">
                <div className="text-xs text-gray-600 mb-1">AI reasoning</div>
                <p className="text-xs text-gray-400">{opp.reasoning}</p>
              </div>
            )}
            <p className="text-xs text-gray-600 pt-2 border-t border-gray-800">
              ⚠ Not financial advice. Always verify prices before trading.
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}

// ── Live arb card ─────────────────────────────────

function LiveArbCard({ opp, rank, bankroll }: { opp: ArbitrageOpp; rank: number; bankroll: number }) {
  const [showModal, setShowModal] = useState(false);
  const lowCfg  = PLATFORMS[opp.lowMarket.platform  as PlatformKey] ?? PLATFORMS.oddsapi;
  const highCfg = PLATFORMS[opp.highMarket.platform as PlatformKey] ?? PLATFORMS.oddsapi;
  const kelly   = kellyFraction(opp.lowMarket.probability, opp.highMarket.probability);
  const bet     = Math.round(bankroll * kelly);

  return (
    <>
      <div className="rounded-xl border border-gray-800 bg-gray-900/60 hover:border-gray-700 transition-all p-4">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 rounded-xl border border-green-700 bg-green-900/40 px-3 py-2 min-w-[64px] text-center">
            <div className="text-lg font-bold text-green-400 leading-none">{opp.roi.toFixed(1)}%</div>
            <div className="text-xs text-gray-500 mt-0.5">ROI</div>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-100 line-clamp-2 mb-2">
              <span className="text-xs text-gray-600 mr-1">#{rank}</span>{opp.question}
            </p>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-800 border border-gray-700 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full ${lowCfg.dotClass}`} />
                <span className="text-gray-400">{opp.lowMarket.bookmaker ?? lowCfg.label}</span>
                <span className="text-red-400 font-bold">{opp.lowMarket.probability}%</span>
              </div>
              <span className="text-gray-600 text-xs">vs</span>
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-800 border border-gray-700 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full ${highCfg.dotClass}`} />
                <span className="text-gray-400">{opp.highMarket.bookmaker ?? highCfg.label}</span>
                <span className="text-green-400 font-bold">{opp.highMarket.probability}%</span>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full border border-green-800 bg-green-950/40 text-green-400">+{opp.spread.toFixed(1)}¢</span>
            </div>
            <div className="flex items-center gap-3 flex-wrap text-xs">
              <span className="text-gray-500">
                ${bankroll.toLocaleString()} → earn ~<span className="text-green-400 font-semibold">${Math.round(bankroll * opp.roi / 100)}</span>
              </span>
              {kelly > 0 && <span className="text-blue-400">Kelly: ${bet}</span>}
              {opp.expiresAt && <span className="text-gray-600">⏱ {expiryLabel(opp.expiresAt)}</span>}
              {opp.gapAge != null && opp.gapAge < H && <span className="text-emerald-400">🔄 fresh</span>}
            </div>
          </div>
          <button onClick={() => setShowModal(true)}
            className="flex-shrink-0 self-start px-2 py-1.5 text-xs rounded-lg border border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500 transition-colors">→</button>
        </div>
      </div>
      {showModal && (
        <Modal title={opp.question} onClose={() => setShowModal(false)}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="p-3 rounded-lg bg-gray-800 border border-gray-700">
                <div className="text-xs text-gray-500 mb-1">{opp.lowMarket.bookmaker ?? lowCfg.label} — BUY HERE</div>
                <div className="text-red-400 font-bold text-xl">{opp.lowMarket.probability}%</div>
                {opp.lowMarket.url && <a href={opp.lowMarket.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline">Open →</a>}
              </div>
              <div className="p-3 rounded-lg bg-gray-800 border border-gray-700">
                <div className="text-xs text-gray-500 mb-1">{opp.highMarket.bookmaker ?? highCfg.label} — REFERENCE</div>
                <div className="text-green-400 font-bold text-xl">{opp.highMarket.probability}%</div>
                {opp.highMarket.url && <a href={opp.highMarket.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline">Open →</a>}
              </div>
            </div>
            <div className="space-y-2 text-sm text-gray-300">
              <div><span className="text-gray-500">1.</span> Buy YES on <strong>{opp.lowMarket.bookmaker ?? lowCfg.label}</strong> at {opp.lowMarket.probability}¢</div>
              <div><span className="text-gray-500">2.</span> Wait for prices to converge or market to resolve</div>
              <div><span className="text-gray-500">3.</span> Expected ROI: <span className="text-green-400 font-bold">{opp.roi.toFixed(1)}%</span> · Kelly bet: <span className="text-blue-400">${bet}</span></div>
            </div>
            <p className="text-xs text-gray-600 border-t border-gray-800 pt-2">⚠ Not financial advice. Verify before trading.</p>
          </div>
        </Modal>
      )}
    </>
  );
}

// ── Platform panel ────────────────────────────────

function PlatformPanel({ platformKey, markets }: { platformKey: PlatformKey; markets: PanelMarket[] }) {
  const cfg = PLATFORMS[platformKey];
  return (
    <div className={`rounded-xl border overflow-hidden ${cfg.borderClass} ${cfg.bgClass}`}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800/60">
        <span className={`w-2 h-2 rounded-full ${cfg.dotClass}`} />
        <h3 className={`font-bold text-sm ${cfg.headerClass}`}>{cfg.label}</h3>
        <span className="ml-auto text-xs text-gray-600">{markets.length}</span>
      </div>
      <div className="divide-y divide-gray-800/30 max-h-60 overflow-y-auto">
        {!markets.length && (
          <p className="px-4 py-3 text-xs text-gray-600">
            {platformKey === 'metaculus' ? 'Auth required' : platformKey === 'augur' ? 'Platform inactive' : 'No data'}
          </p>
        )}
        {markets.map(m => (
          <div key={m.id} className="px-4 py-2.5 flex items-center justify-between gap-2 hover:bg-white/[0.02]">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-gray-300 line-clamp-1">{m.name}</p>
              {m.volume != null && m.volume > 0 && <p className="text-xs text-gray-700">{fmtDollars(m.volume)} vol</p>}
            </div>
            {m.probability != null && (
              <span className={`text-sm font-bold tabular-nums flex-shrink-0 ${
                m.probability >= 70 ? 'text-green-400' : m.probability >= 40 ? 'text-yellow-400' : 'text-red-400'
              }`}>{m.probability}%</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stats Tab ─────────────────────────────────────

function StatsTab({ data }: { data: StatsData | null }) {
  if (!data) return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
      <div className="text-4xl mb-3">📊</div><p className="text-gray-300 font-semibold">Loading stats…</p>
    </div>
  );
  const { stats, charts } = data;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {[
          { label: 'Total AI Scans',        value: String(stats.totalScans),                                    color: 'text-blue-400' },
          { label: 'Total Opportunities',   value: String(stats.totalOpps),                                     color: 'text-green-400' },
          { label: 'Avg AI Confidence',     value: `${stats.avgConfAll}%`,                                      color: 'text-amber-400' },
          { label: 'Telegram Alerts',       value: String(stats.totalAlerts),                                   color: 'text-purple-400' },
          { label: 'Best Confidence Ever',  value: `${stats.bestConf}%`,                                        color: 'text-emerald-400' },
          { label: 'Current Best ROI',      value: stats.currentBestRoi > 0 ? `${stats.currentBestRoi.toFixed(1)}%` : '—', color: 'text-yellow-400' },
        ].map(c => (
          <div key={c.label} className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
            <div className="text-xs text-gray-500 mt-1">{c.label}</div>
          </div>
        ))}
      </div>
      {charts.labels.length >= 2 && (
        <>
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-5">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">Opportunities per day (last 14 days)</h3>
            <Sparkline data={charts.oppsByDay} color="#22c55e" height={48} />
            <div className="flex justify-between mt-1 text-xs text-gray-600">
              <span>{charts.labels[0]}</span><span>{charts.labels[charts.labels.length - 1]}</span>
            </div>
          </div>
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-5">
            <h3 className="text-sm font-semibold text-gray-300 mb-3">AI confidence per day (last 14 days)</h3>
            <Sparkline data={charts.confByDay} color="#f59e0b" height={48} />
          </div>
        </>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────

const REFRESH = 30;
const EMPTY_PANELS: MarketsResponse['panels'] = {
  predictit: [], manifold: [], kalshi: [], polymarket: [],
  betfair: [], metaculus: [], augur: [], gnosis: [], futuur: [],
  goodjudgment: [], oddsapi: [], opinionmarkets: [],
};
type FullResponse = MarketsResponse & { masterOpportunities?: MasterOpp[] };

export default function Home() {
  const { data: session } = useSession();
  const [panels,        setPanels]        = useState<MarketsResponse['panels']>(EMPTY_PANELS);
  const [arbCandidates, setArbCandidates] = useState<ArbCandidate[]>([]);
  const [masterOpps,    setMasterOpps]    = useState<MasterOpp[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [lastUpdate,    setLastUpdate]    = useState<Date | null>(null);
  const [countdown,     setCountdown]     = useState(REFRESH);
  const [bankroll,      setBankroll]      = useState(1000);
  const [activeTab,     setActiveTab]     = useState<'opportunities' | 'markets' | 'crypto' | 'sports' | 'weather' | 'stats' | 'marketmaking' | 'liquidity'>('opportunities');
  const [typeFilter,    setTypeFilter]    = useState<OppTypeFilter>('all');
  const [crypto,        setCrypto]        = useState<CryptoResponse | null>(null);
  const [sports,        setSports]        = useState<SportsResponse | null>(null);
  const [weather,       setWeather]       = useState<WeatherResponse | null>(null);
  const [statsData,     setStatsData]     = useState<StatsData | null>(null);
  const [mmData,        setMmData]        = useState<MmResponse | null>(null);
  const [lpData,        setLpData]        = useState<LpResponse | null>(null);
  const [healthOk,      setHealthOk]      = useState<boolean | null>(null);
  const [userMenuOpen,  setUserMenuOpen]  = useState(false);
  const [userPlan,      setUserPlan]      = useState<string>('free');
  const menuRef = useRef<HTMLDivElement>(null);

  const fetchMarkets = useCallback(async () => {
    const tid = setTimeout(() => setLoading(false), 8000);
    try {
      const ctl = new AbortController();
      const t2  = setTimeout(() => ctl.abort(), 7000);
      const data: FullResponse = await fetch('/api/markets', { cache: 'no-store', signal: ctl.signal }).then(r => r.json());
      clearTimeout(t2);
      setPanels(data.panels);
      setArbCandidates(data.arbCandidates);
      setMasterOpps(data.masterOpportunities ?? []);
      setLastUpdate(new Date()); setCountdown(REFRESH);
    } catch {}
    finally { clearTimeout(tid); setLoading(false); }
  }, []);

  const fetchAux = useCallback(async () => {
    const [cr, sr, wr, st, mm, lp, hlt] = await Promise.allSettled([
      fetch('/api/crypto',       { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/sports',       { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/weather',      { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/stats',        { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/marketmaker',  { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/liquidity',    { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/health',       { cache: 'no-store' }).then(r => r.json()),
    ]);
    if (cr.status  === 'fulfilled') setCrypto(cr.value);
    if (sr.status  === 'fulfilled') setSports(sr.value);
    if (wr.status  === 'fulfilled') setWeather(wr.value);
    if (st.status  === 'fulfilled') setStatsData(st.value);
    if (mm.status  === 'fulfilled') setMmData(mm.value);
    if (lp.status  === 'fulfilled') setLpData(lp.value);
    if (hlt.status === 'fulfilled') setHealthOk(hlt.value?.ok ?? null);
  }, []);

  useEffect(() => {
    fetchMarkets(); fetchAux();
    const iv = setInterval(() => { fetchMarkets(); fetchAux(); }, REFRESH * 1000);
    return () => clearInterval(iv);
  }, [fetchMarkets, fetchAux]);

  useEffect(() => {
    const t = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (session?.user) {
      fetch('/api/subscription').then(r => r.json()).then(d => { if (d.plan) setUserPlan(d.plan); }).catch(() => {});
    }
  }, [session]);

  const liveArb = detectArbitrage(arbCandidates);
  const filteredMaster = typeFilter === 'all' ? masterOpps : masterOpps.filter(o => o.type === typeFilter);

  const totalMarkets   = Object.values(panels).reduce((s, p) => s + p.length, 0);
  const platformCount  = Object.values(panels).filter(p => p.length > 0).length;
  const bestRoi        = masterOpps.length > 0 ? Math.max(...masterOpps.map(o => o.roi)) : (liveArb[0]?.roi ?? 0);
  const bestNet        = masterOpps.length > 0 ? Math.max(...masterOpps.filter(o => o.net_profit != null).map(o => o.net_profit ?? 0)) : 0;

  const OPP_FILTERS: { key: OppTypeFilter; label: string }[] = [
    { key: 'all',               label: 'All' },
    { key: 'prediction_market', label: '🔮 Prediction Arb' },
    { key: 'funding_rate',      label: '⚡ Funding Rate' },
    { key: 'sports_arb',        label: '🏟️ Sports Arb' },
    { key: 'info_lag',          label: '⚠️ Info Lag' },
    { key: 'cex_arb',           label: '💱 CEX Arb' },
    { key: 'cash_carry',        label: '⚖️ Cash & Carry' },
  ];

  if (loading) return (
    <div className="bg-gray-950 min-h-screen flex flex-col items-center justify-center gap-4">
      <div className="flex gap-2">{[0,1,2].map(i => <div key={i} className="w-3 h-3 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />)}</div>
      <p className="text-gray-400 text-sm">Scanning prediction markets…</p>
    </div>
  );

  return (
    <main className="bg-gray-950 min-h-screen text-white">

      {/* ── HEADER ────────────────────────────────── */}
      <header className="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/90 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-4 flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5 mb-0.5">
              <h1 className="text-xl md:text-2xl font-bold tracking-tight">Prediction Market Scanner</h1>
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-green-700 bg-green-900/40 text-xs font-bold text-green-400">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />LIVE
              </span>
            </div>
            <p className="text-gray-500 text-xs hidden sm:block">
              Scanning {totalMarkets} markets across {platformCount} platforms · AI analysis every 30min
            </p>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {/* System health dot */}
            <div className="hidden sm:flex items-center gap-1.5 text-xs" title="System health — /api/health">
              <span className={`w-2 h-2 rounded-full ${
                healthOk === true ? 'bg-green-400' : healthOk === false ? 'bg-red-400 animate-pulse' : 'bg-gray-600'
              }`} />
              <span className={healthOk === false ? 'text-red-400' : 'text-gray-600'}>
                {healthOk === true ? 'All systems ok' : healthOk === false ? 'Agent issue' : 'Checking…'}
              </span>
            </div>
            <div className="text-right hidden sm:block">
              <div className="text-xs text-gray-600">Last scan</div>
              <div className="text-sm font-medium text-gray-300">{lastUpdate ? timeAgo(lastUpdate) : '—'}</div>
              <div className="text-xs text-gray-600 tabular-nums">refresh in {countdown}s</div>
            </div>
            {/* User menu */}
            <div className="relative" ref={menuRef}>
              {session?.user ? (
                <button onClick={() => setUserMenuOpen(v => !v)}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 hover:border-gray-500 transition-colors text-sm">
                  <span className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold text-white">
                    {(session.user.name?.[0] ?? session.user.email?.[0] ?? '?').toUpperCase()}
                  </span>
                  <span className="text-gray-300 hidden sm:block max-w-[100px] truncate">{session.user.name ?? session.user.email?.split('@')[0]}</span>
                  {userPlan !== 'free' && (
                    <span className="px-1.5 py-0.5 rounded text-xs font-bold bg-blue-600 text-white uppercase">{userPlan === 'profit_share' ? 'PS' : 'PRO'}</span>
                  )}
                  <span className="text-gray-500 text-xs">▾</span>
                </button>
              ) : (
                <Link href="/auth/login" className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-xs font-semibold hover:border-gray-500 hover:text-gray-300 transition-colors">
                  Sign In
                </Link>
              )}
              {userMenuOpen && session?.user && (
                <div className="absolute right-0 top-full mt-1 w-52 rounded-xl bg-gray-900 border border-gray-700 shadow-2xl overflow-hidden z-50">
                  <div className="px-4 py-3 border-b border-gray-800">
                    <p className="text-xs text-gray-300 font-semibold truncate">{session.user.name ?? 'User'}</p>
                    <p className="text-xs text-gray-600 truncate">{session.user.email}</p>
                    <span className="mt-1 inline-block px-2 py-0.5 rounded text-xs font-bold bg-gray-800 text-gray-400 uppercase">
                      {userPlan === 'profit_share' ? 'Profit Share' : userPlan}
                    </span>
                  </div>
                  <div className="py-1">
                    <Link href="/dashboard/portfolio" className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors" onClick={() => setUserMenuOpen(false)}>
                      📊 My Portfolio
                    </Link>
                    <Link href="/dashboard/history" className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors" onClick={() => setUserMenuOpen(false)}>
                      📜 History
                    </Link>
                    <Link href="/dashboard/preferences" className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors" onClick={() => setUserMenuOpen(false)}>
                      ⚙️ Preferences
                    </Link>
                    {userPlan === 'free' && (
                      <Link href="/dashboard/upgrade" className="flex items-center gap-2 px-4 py-2.5 text-sm text-blue-400 hover:bg-gray-800 hover:text-blue-300 transition-colors font-semibold" onClick={() => setUserMenuOpen(false)}>
                        ⚡ Upgrade to Pro
                      </Link>
                    )}
                  </div>
                  <div className="border-t border-gray-800 py-1">
                    <button onClick={() => signOut({ callbackUrl: '/' })}
                      className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-gray-800 transition-colors">
                      ↩ Sign Out
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 md:px-6 py-6 space-y-5">

        {/* ── SUMMARY CARDS ───────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-xl border border-blue-800/40 bg-blue-950/20 p-4">
            <div className="text-2xl font-bold tabular-nums">{totalMarkets}</div>
            <div className="text-sm font-medium text-gray-200 mt-1">Markets Monitored</div>
            <div className="text-xs text-gray-500 mt-0.5">{platformCount} platforms active</div>
          </div>
          <div className={`rounded-xl border p-4 ${filteredMaster.length + liveArb.length > 0 ? 'border-green-800/40 bg-green-950/20' : 'border-gray-700/40 bg-gray-800/20'}`}>
            <div className="text-2xl font-bold tabular-nums">{filteredMaster.length + liveArb.length}</div>
            <div className="text-sm font-medium text-gray-200 mt-1">Opportunities</div>
            <div className="text-xs text-gray-500 mt-0.5">{masterOpps.length} AI · {liveArb.length} live</div>
          </div>
          <div className={`rounded-xl border p-4 ${bestRoi > 0 ? 'border-yellow-800/40 bg-yellow-950/20' : 'border-gray-700/40 bg-gray-800/20'}`}>
            <div className={`text-2xl font-bold tabular-nums ${bestRoi > 0 ? 'text-yellow-400' : 'text-gray-600'}`}>
              {bestRoi > 0 ? `${bestRoi.toFixed(1)}%` : '—'}
            </div>
            <div className="text-sm font-medium text-gray-200 mt-1">Best ROI</div>
            <div className="text-xs text-gray-500 mt-0.5">return on investment</div>
          </div>
          <div className={`rounded-xl border p-4 ${bestNet > 0 ? 'border-purple-800/40 bg-purple-950/20' : 'border-gray-700/40 bg-gray-800/20'}`}>
            <div className={`text-2xl font-bold tabular-nums ${bestNet > 0 ? 'text-purple-400' : 'text-gray-600'}`}>
              {bestNet > 0 ? `$${Math.round((bankroll/1000)*bestNet)}` : '—'}
            </div>
            <div className="text-sm font-medium text-gray-200 mt-1">Est. Profit</div>
            <div className="text-xs text-gray-500 mt-0.5">on ${bankroll.toLocaleString()} · after fees</div>
          </div>
        </div>

        {/* ── BANKROLL ────────────────────────────── */}
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-gray-800 bg-gray-900/40">
          <span className="text-sm text-gray-400">Bankroll:</span>
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
            <input type="number" min={1} value={bankroll}
              onChange={e => setBankroll(Math.max(1, parseInt(e.target.value) || 1))}
              className="pl-6 pr-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm w-28 focus:outline-none focus:border-blue-600" />
          </div>
          <span className="text-xs text-gray-600 ml-auto hidden md:block">Profit estimates scale with bankroll · Not financial advice</span>
        </div>

        {/* ── TABS ────────────────────────────────── */}
        <div className="flex flex-wrap gap-1 p-1 rounded-xl bg-gray-900 border border-gray-800">
          {([
            { key: 'opportunities', label: '🔍 Arbitrage' },
            { key: 'markets',       label: '📡 Markets' },
            { key: 'crypto',        label: '⚡ Crypto' },
            { key: 'sports',        label: '🏟️ Sports' },
            { key: 'weather',       label: '🌤️ Weather' },
            { key: 'marketmaking',  label: '⚙️ Market Making' },
            { key: 'liquidity',     label: '💧 Liquidity' },
            { key: 'stats',         label: '📊 Stats' },
          ] as const).map(({ key, label }) => {
            const mmBadge = key === 'marketmaking' && (mmData?.opportunities?.length ?? 0) > 0 ? String(mmData!.opportunities.length) : null;
            return (
              <button key={key} onClick={() => setActiveTab(key)}
                className={`relative px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap ${
                  activeTab === key ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}>
                {label}
                {mmBadge && <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-orange-500 text-white text-[9px] font-bold flex items-center justify-center">{mmBadge}</span>}
              </button>
            );
          })}
        </div>

        {/* ── OPPORTUNITIES TAB ───────────────────── */}
        {activeTab === 'opportunities' && (
          <div className="space-y-5">
            {/* Type filters */}
            <div className="flex flex-wrap gap-1.5">
              {OPP_FILTERS.map(({ key, label }) => (
                <button key={key} onClick={() => setTypeFilter(key)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                    typeFilter === key ? 'bg-blue-700 border-blue-600 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-300'
                  }`}>{label}</button>
              ))}
            </div>

            {/* AI Master opportunities */}
            {filteredMaster.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-lg font-bold">AI Master Analysis</h2>
                  <span className="text-xs px-2 py-0.5 rounded-full border border-blue-700 bg-blue-900/40 text-blue-300">{filteredMaster.length}</span>
                  <span className="text-xs text-gray-600 ml-auto">Claude Sonnet · every 30min</span>
                </div>
                <div className="space-y-3">
                  {filteredMaster.map((opp, i) => <MasterOppCard key={opp.id ?? i} opp={opp} bankroll={bankroll} />)}
                </div>
              </section>
            )}

            {/* Live detected spreads */}
            {liveArb.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-lg font-bold">Live Detected Spreads</h2>
                  <span className="text-xs px-2 py-0.5 rounded-full border border-green-700 bg-green-900/40 text-green-300">{liveArb.length}</span>
                  <span className="text-xs text-gray-600 ml-auto">Keyword-matched · 30s refresh</span>
                </div>
                <div className="space-y-2">
                  {liveArb.map((opp, i) => <LiveArbCard key={i} opp={opp} rank={i + 1} bankroll={bankroll} />)}
                </div>
              </section>
            )}

            {/* Empty state */}
            {filteredMaster.length === 0 && liveArb.length === 0 && (
              <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
                {totalMarkets === 0 ? (
                  <><div className="text-4xl mb-3">⏳</div>
                  <p className="text-gray-300 font-semibold">Waiting for first scan…</p>
                  <p className="text-gray-600 text-sm mt-1">AI master agent runs every 30 minutes.</p></>
                ) : (
                  <><div className="text-4xl mb-3">🔎</div>
                  <p className="text-gray-300 font-semibold">
                    {typeFilter !== 'all' ? `No ${typeLabel(typeFilter)} opportunities right now` : 'No opportunities right now'}
                  </p>
                  <p className="text-gray-600 text-sm mt-1">
                    {typeFilter !== 'all' ? 'Try "All" to see other types.' : 'Markets are pricing consistently. Check back in 30s.'}
                  </p></>
                )}
              </div>
            )}

            {/* Explainer */}
            <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-5">
              <div className="flex gap-3">
                <span className="text-2xl flex-shrink-0">💡</span>
                <div>
                  <h3 className="font-semibold text-gray-200 mb-1 text-sm">How this works</h3>
                  <p className="text-gray-500 text-xs leading-relaxed">
                    <strong className="text-gray-300">AI Master</strong> uses Claude to analyze all 5 platform data sources plus CEX prices every 30min, returning ranked opportunities with confidence scores and exact execution steps.
                    <strong className="text-gray-300"> Live Spreads</strong> continuously keyword-match markets across platforms in real-time.
                    Always verify prices before trading.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── MARKETS TAB ─────────────────────────── */}
        {activeTab === 'markets' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Live Markets by Platform</h2>
              <span className="text-xs text-gray-600">{totalMarkets} total · updated every 5min</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {(Object.keys(PLATFORMS) as PlatformKey[]).map(key => (
                <PlatformPanel key={key} platformKey={key} markets={(panels as any)[key] ?? []} />
              ))}
            </div>
          </div>
        )}

        {activeTab === 'crypto'        && <CryptoTab data={crypto} />}
        {activeTab === 'sports'        && <SportsTab data={sports} />}
        {activeTab === 'weather'       && <WeatherTab data={weather} />}
        {activeTab === 'stats'         && <StatsTab data={statsData} />}
        {activeTab === 'marketmaking'  && <MarketMakingTab data={mmData} bankroll={bankroll} />}
        {activeTab === 'liquidity'     && <LiquidityTab data={lpData} />}

      </div>

      {/* Upgrade banner for free users */}
      {session?.user && userPlan === 'free' && (
        <div className="border-t border-gray-800 bg-gray-900/60 py-3 px-4">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-sm text-gray-400">
              <span className="text-white font-semibold">Free plan:</span> You see the top 3 opportunities. Upgrade to unlock all signals, Telegram alerts, and Kelly sizing.
            </p>
            <Link href="/dashboard/upgrade"
              className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors whitespace-nowrap">
              Upgrade to Pro — €15/mo
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}

// ── Market Making Tab ────────────────────────────

function MarketMakingTab({ data, bankroll }: { data: MmResponse | null; bankroll: number }) {
  if (!data) return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
      <div className="text-4xl mb-3">⚙️</div>
      <p className="text-gray-300 font-semibold">Loading market-making data…</p>
      <p className="text-gray-600 text-sm mt-1">agent-marketmaker monitors BTC/ETH/SOL via Binance WebSocket.</p>
    </div>
  );

  const { opportunities, dataAge } = data;
  const dataStale = dataAge > 3_600_000;
  const highConf  = opportunities.filter(o => o.confidence >= 70);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 flex-wrap">
        <div className={`rounded-lg border px-4 py-2 text-center ${highConf.length > 0 ? 'border-orange-700 bg-orange-950/30' : 'border-gray-800 bg-gray-900/40'}`}>
          <div className={`text-xl font-bold tabular-nums ${highConf.length > 0 ? 'text-orange-400' : ''}`}>{highConf.length}</div>
          <div className="text-xs text-gray-500">Active Info-Lag Opps</div>
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-2 text-center">
          <div className="text-xl font-bold tabular-nums">{opportunities.length}</div>
          <div className="text-xs text-gray-500">Total Detected</div>
        </div>
        <div className={`rounded-lg border px-4 py-2 text-center ${dataStale ? 'border-red-800 bg-red-950/30' : 'border-gray-800 bg-gray-900/40'}`}>
          <div className={`text-sm font-semibold ${dataStale ? 'text-red-400' : 'text-gray-400'}`}>{Math.round(dataAge / 60000)}m ago</div>
          <div className="text-xs text-gray-500">Last detection</div>
        </div>
        <div className="text-xs text-gray-600 ml-auto max-w-xs text-right hidden md:block">
          WebSocket detects &gt;2% price moves in 5-min windows. Info-lag = prediction market hasn&apos;t repriced yet.
        </div>
      </div>

      {opportunities.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
          <div className="text-4xl mb-3">📡</div>
          <p className="text-gray-300 font-semibold">No info-lag opportunities right now</p>
          <p className="text-gray-600 text-sm mt-1">Monitoring BTC, ETH, SOL for &gt;2% moves that prediction markets haven&apos;t priced in.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {opportunities.slice(0, 20).map((opp, i) => {
            const kellyBet = Math.round(bankroll * opp.kellyFrac);
            const isUp = opp.direction === 'UP';
            return (
              <div key={i} className={`rounded-xl border p-4 transition-all ${opp.confidence >= 70 ? 'border-orange-800/60 bg-orange-950/10' : 'border-gray-800 bg-gray-900/40'}`}>
                <div className="flex items-start gap-4">
                  <div className={`flex-shrink-0 rounded-xl border px-3 py-2 min-w-[72px] text-center ${opp.confidence >= 70 ? 'border-orange-700 bg-orange-900/40' : 'border-gray-700 bg-gray-800'}`}>
                    <div className={`text-xl font-bold leading-none ${opp.confidence >= 70 ? 'text-orange-400' : 'text-gray-400'}`}>{opp.confidence}%</div>
                    <div className="text-xs text-gray-500 mt-0.5">conf</div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${isUp ? 'border-green-700 bg-green-900/40 text-green-300' : 'border-red-700 bg-red-900/40 text-red-300'}`}>
                        {opp.coin} {isUp ? '▲' : '▼'} {opp.movePct > 0 ? '+' : ''}{opp.movePct}%
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded border border-gray-700 text-gray-500 capitalize">{opp.source}</span>
                    </div>
                    <p className="text-sm font-semibold text-gray-100 mb-1 line-clamp-2">{opp.marketTitle}</p>
                    <p className="text-xs text-gray-400 mb-2">{opp.action}</p>
                    <div className="flex items-center gap-3 text-xs flex-wrap">
                      <span className="text-gray-500">Market prob: <span className="text-white font-semibold">{opp.currentProb}¢</span></span>
                      {opp.kellyFrac > 0 && <span className="text-blue-400">Kelly: ${kellyBet} ({(opp.kellyFrac * 100).toFixed(1)}%)</span>}
                      <span className="text-gray-600">{new Date(opp.detectedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>
                      {opp.url && <a href={opp.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Open →</a>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-5">
        <div className="flex gap-3">
          <span className="text-2xl flex-shrink-0">⚙️</span>
          <div>
            <h3 className="font-semibold text-gray-200 mb-1 text-sm">How Market Making Works</h3>
            <p className="text-gray-500 text-xs leading-relaxed">
              agent-marketmaker connects to Binance WebSocket for real-time BTC/ETH/SOL prices.
              When a coin moves &gt;2% in a 5-minute window, it scans Kalshi and Polymarket for markets
              referencing that coin whose probability hasn&apos;t reflected the move yet.
              The <strong className="text-gray-300">Kelly criterion</strong> suggests what fraction of bankroll maximizes log-growth.
              <strong className="text-gray-300"> This is detection only</strong> — all execution is manual.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Liquidity Tab ────────────────────────────────

function LiquidityTab({ data }: { data: LpResponse | null }) {
  if (!data) return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
      <div className="text-4xl mb-3">💧</div>
      <p className="text-gray-300 font-semibold">Loading liquidity data…</p>
      <p className="text-gray-600 text-sm mt-1">agent-liquidity fetches Polymarket LP metrics every 10 minutes.</p>
    </div>
  );

  const { positions, topMarketsForLp, summary, dataAge } = data;
  const dataStale = dataAge > 1_800_000;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-2 text-center">
          <div className="text-xl font-bold tabular-nums">{summary.totalPositions}</div>
          <div className="text-xs text-gray-500">Active Positions</div>
        </div>
        {summary.needsRebalance > 0 && (
          <div className="rounded-lg border border-amber-700 bg-amber-950/30 px-4 py-2 text-center">
            <div className="text-xl font-bold text-amber-400 tabular-nums">{summary.needsRebalance}</div>
            <div className="text-xs text-gray-500">Need Rebalance</div>
          </div>
        )}
        {summary.totalNotional > 0 && (
          <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-2 text-center">
            <div className="text-xl font-bold tabular-nums">${summary.totalNotional.toLocaleString()}</div>
            <div className="text-xs text-gray-500">Total Notional</div>
          </div>
        )}
        {summary.totalNetPnl !== 0 && (
          <div className={`rounded-lg border px-4 py-2 text-center ${summary.totalNetPnl >= 0 ? 'border-green-800 bg-green-950/20' : 'border-red-800 bg-red-950/20'}`}>
            <div className={`text-xl font-bold tabular-nums ${summary.totalNetPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {summary.totalNetPnl >= 0 ? '+' : ''}${summary.totalNetPnl.toFixed(2)}
            </div>
            <div className="text-xs text-gray-500">Net PnL</div>
          </div>
        )}
        <div className={`rounded-lg border px-4 py-2 text-center ${dataStale ? 'border-red-800 bg-red-950/30' : 'border-gray-800 bg-gray-900/40'}`}>
          <div className={`text-sm font-semibold ${dataStale ? 'text-red-400' : 'text-gray-400'}`}>{Math.round(dataAge / 60000)}m ago</div>
          <div className="text-xs text-gray-500">Last update</div>
        </div>
      </div>

      {/* Active LP positions */}
      {positions.length > 0 ? (
        <section>
          <h2 className="text-lg font-bold mb-3">Active Positions</h2>
          <div className="space-y-3">
            {positions.map((pos, i) => (
              <div key={i} className={`rounded-xl border p-4 ${pos.needsRebalance ? 'border-amber-800/60 bg-amber-950/10' : 'border-gray-800 bg-gray-900/40'}`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    {pos.needsRebalance && <div className="text-xs font-bold text-amber-400 mb-1">⚠ REBALANCE NEEDED</div>}
                    <p className="text-sm font-semibold text-gray-100 line-clamp-2 mb-2">{pos.question}</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      <div><span className="text-gray-500">Entry:</span> <span className="text-white font-semibold">{pos.entryPrice}¢</span></div>
                      <div><span className="text-gray-500">Current:</span> <span className={`font-semibold ${pos.currentPrice > pos.entryPrice ? 'text-green-400' : 'text-red-400'}`}>{pos.currentPrice}¢</span></div>
                      <div><span className="text-gray-500">IL:</span> <span className={`font-semibold ${Math.abs(pos.il) > 3 ? 'text-red-400' : 'text-gray-300'}`}>{pos.il}%</span></div>
                      <div><span className="text-gray-500">LP APY:</span> <span className="text-blue-400 font-semibold">{pos.lpApy}%</span></div>
                      <div><span className="text-gray-500">Notional:</span> <span className="text-gray-300">${pos.notionalUSD.toLocaleString()}</span></div>
                      <div><span className="text-gray-500">Fees:</span> <span className="text-green-400">+${pos.feesEarned.toFixed(2)}</span></div>
                      <div><span className="text-gray-500">Net PnL:</span> <span className={pos.netPnl >= 0 ? 'text-green-400 font-semibold' : 'text-red-400 font-semibold'}>{pos.netPnl >= 0 ? '+' : ''}${pos.netPnl.toFixed(2)}</span></div>
                      <div><span className="text-gray-500">Held:</span> <span className="text-gray-300">{pos.daysHeld}d</span></div>
                    </div>
                  </div>
                  {pos.url && <a href={pos.url} target="_blank" rel="noopener noreferrer" className="flex-shrink-0 px-2 py-1.5 text-xs rounded-lg border border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500 transition-colors">→</a>}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-8 text-center">
          <p className="text-gray-500 text-sm">No active LP positions configured.</p>
          <p className="text-gray-600 text-xs mt-1">Add positions to <code className="text-gray-500">/tmp/lp-positions-config.json</code></p>
        </div>
      )}

      {/* Top markets for new LP */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-lg font-bold">Best Markets for LP</h2>
          <span className="text-xs px-2 py-0.5 rounded-full border border-gray-700 text-gray-500">{topMarketsForLp.length} markets</span>
          <span className="text-xs text-gray-600 ml-auto">Near 50/50 price · sorted by 24h volume</span>
        </div>
        <div className="rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900/60">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Market</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">YES%</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Vol 24h</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Est LP APY</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {topMarketsForLp.map(m => (
                <tr key={m.id} className={`hover:bg-white/[0.02] ${m.isNear50 ? 'bg-blue-950/5' : ''}`}>
                  <td className="px-4 py-2.5 text-gray-200 max-w-sm">
                    <a href={m.url ?? '#'} target="_blank" rel="noopener noreferrer" className="line-clamp-2 text-xs hover:text-white hover:underline">{m.question}</a>
                    {m.isNear50 && <span className="ml-1 text-xs text-blue-500">near 50%</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span className={`font-bold tabular-nums text-xs ${m.price >= 70 ? 'text-green-400' : m.price >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>{m.price}¢</span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-xs text-gray-400">${m.volume24h.toLocaleString()}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums text-xs font-semibold ${m.lpApyEstimate >= 5 ? 'text-green-400' : m.lpApyEstimate >= 2 ? 'text-yellow-400' : 'text-gray-500'}`}>
                    {m.lpApyEstimate > 0 ? `${m.lpApyEstimate}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-600 mt-2">LP APY estimated from 24h volume × 0.1% fee × 50% LP share. Not actual APY.</p>
      </section>

      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-5">
        <div className="flex gap-3">
          <span className="text-2xl flex-shrink-0">💧</span>
          <div>
            <h3 className="font-semibold text-gray-200 mb-1 text-sm">Impermanent Loss Formula</h3>
            <p className="text-gray-500 text-xs leading-relaxed">
              For binary prediction market AMMs: <strong className="text-gray-300">IL = 2√(p/p₀)/(1 + p/p₀) − 1</strong> where p₀ is entry price, p is current price.
              At &gt;3% IL or &gt;10% price divergence, rebalancing is recommended to lock in fee income.
              LP earns fees only when price is near 50/50 — at extremes (&lt;20% or &gt;80%), fee income drops sharply.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Crypto Tab (full detail) ──────────────────────

const COIN_META: Record<string, { label: string; emoji: string }> = {
  BTC:  { label: 'Bitcoin',  emoji: '₿' }, ETH:  { label: 'Ethereum', emoji: 'Ξ' },
  SOL:  { label: 'Solana',   emoji: '◎' }, BNB:  { label: 'BNB',      emoji: '⬡' },
  XRP:  { label: 'XRP',      emoji: '✕' }, DOGE: { label: 'Dogecoin', emoji: 'Ð' },
};
const EXCHANGE_LABEL: Record<string, string> = { binance: 'Binance', coinbase: 'Coinbase', okx: 'OKX', bybit: 'Bybit', kraken: 'Kraken', gateio: 'Gate.io' };
const DEX_LABEL: Record<string, string> = { jupiter: 'Jupiter (SOL)', dydx: 'dYdX', uniswap: 'Uniswap V3', '1inch': '1inch' };

function fmtPrice(p: number): string {
  if (p >= 1000) return `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (p >= 1)    return `$${p.toFixed(2)}`;
  return `$${p.toFixed(4)}`;
}
function fundingClass(fr: number): string {
  if (fr > 0.1)  return 'text-red-400 font-bold';
  if (fr > 0)    return 'text-red-400';
  if (fr < -0.1) return 'text-green-400 font-bold';
  return 'text-green-400';
}

function CryptoTab({ data }: { data: CryptoResponse | null }) {
  if (!data) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
        <div className="text-5xl mb-4">⚡</div>
        <p className="text-gray-300 font-semibold text-lg">Loading exchange prices…</p>
        <p className="text-gray-600 text-sm mt-2">agent10-binance (WebSocket + REST) + agent11-dex fetch every 60s / 5min.</p>
      </div>
    );
  }

  const { exchanges, cexArb, infoLag, futures, basisTrades, highFunding, dex, dexCexSpread, cryptoMarkets, dataAge } = data;
  const dataStale      = dataAge > 180_000;
  const infoLagMarkets = cryptoMarkets.filter(m => m.infoLag);
  const coins          = Object.keys(COIN_META);
  const exchangeNames  = Object.keys(exchanges);
  const perpCoins      = ['BTC','ETH','SOL'];
  const dexSources     = Object.keys(dex).filter(s => Object.keys(dex[s]).length > 0);

  function bestPrice(coin: string): number | null {
    const prices = exchangeNames.map(ex => exchanges[ex]?.[coin]?.price).filter((p): p is number => p > 0);
    if (!prices.length) return null;
    prices.sort((a, b) => a - b);
    return prices[Math.floor(prices.length / 2)];
  }
  function change24h(coin: string) { return exchanges.binance?.[coin]?.change24hPct ?? null; }

  return (
    <div className="space-y-8">
      {/* Alert banners */}
      <div className="space-y-3">
        {highFunding.length > 0 && (
          <div className="rounded-xl border border-red-700 bg-red-950/30 p-4 flex gap-3 items-start">
            <span className="text-2xl flex-shrink-0">🔥</span>
            <div className="flex-1">
              <p className="font-semibold text-red-300 mb-2">Funding Rate Arbitrage — {highFunding.length} contract{highFunding.length > 1 ? 's' : ''}</p>
              <div className="space-y-2">
                {highFunding.map((h, i) => (
                  <div key={i} className="text-xs font-mono px-3 py-2 rounded border border-red-700 bg-red-900/40 text-red-200 flex flex-wrap items-center gap-2">
                    <span className="font-bold text-white">{h.coin}</span>
                    <span className="text-red-300">Hold {h.coin} {h.fundingRate > 0 ? 'SHORT' : 'LONG'} on {EXCHANGE_LABEL[h.exchange] ?? h.exchange} Perp</span>
                    <span className="text-gray-400">|</span>
                    <span>Earn <span className="text-yellow-300 font-bold">{Math.abs(h.fundingRate).toFixed(4)}% every 8h</span></span>
                    <span className="text-gray-400">|</span>
                    <span className="text-green-400 font-bold">= {h.annualizedApy != null ? Math.abs(h.annualizedApy).toFixed(1) : (Math.abs(h.fundingRate) * 3 * 365).toFixed(1)}% APY</span>
                    <span className="text-gray-500 italic ml-1">(hedge with {h.fundingRate > 0 ? 'spot long' : 'spot short'} to stay neutral)</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {basisTrades.length > 0 && (
          <div className="rounded-xl border border-violet-700 bg-violet-950/30 p-4 flex gap-3 items-start">
            <span className="text-2xl flex-shrink-0">⚖️</span>
            <div className="flex-1">
              <p className="font-semibold text-violet-300 mb-2">Cash &amp; Carry Arbitrage — {basisTrades.length} opportunit{basisTrades.length > 1 ? 'ies' : 'y'}</p>
              <div className="space-y-2">
                {basisTrades.map(b => (
                  <div key={b.coin} className="text-xs font-mono px-3 py-2 rounded border border-violet-700 bg-violet-900/40 text-violet-200 flex flex-wrap items-center gap-2">
                    <span className="font-bold text-white">{b.coin}</span>
                    {b.direction === 'contango' ? (
                      <>
                        <span>Buy <span className="text-blue-300">{b.coin} spot</span> at {fmtPrice(b.spot)}</span>
                        <span className="text-gray-400">|</span>
                        <span>Sell <span className="text-red-300">{b.coin} perp</span> at {fmtPrice(b.futures)}</span>
                        <span className="text-gray-400">|</span>
                        <span>Lock <span className="text-green-400 font-bold">{b.basisPct.toFixed(2)}%</span></span>
                        {b.profitPerUnit != null && <span className="text-yellow-300">(${b.profitPerUnit.toFixed(0)} per coin)</span>}
                      </>
                    ) : (
                      <>
                        <span>Buy <span className="text-blue-300">{b.coin} perp</span> at {fmtPrice(b.futures)}</span>
                        <span className="text-gray-400">|</span>
                        <span>Sell <span className="text-red-300">{b.coin} spot</span> at {fmtPrice(b.spot)}</span>
                        <span className="text-gray-400">|</span>
                        <span>Lock <span className="text-green-400 font-bold">{Math.abs(b.basisPct).toFixed(2)}%</span> discount</span>
                      </>
                    )}
                    {b.annualizedReturn != null && (
                      <><span className="text-gray-400">|</span><span className="text-emerald-400 font-bold">~{b.annualizedReturn.toFixed(1)}% annualized</span></>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {cexArb.length > 0 && (
          <div className="rounded-xl border border-blue-700 bg-blue-950/30 p-4 flex gap-3 items-start">
            <span className="text-2xl flex-shrink-0">💱</span>
            <div className="flex-1">
              <p className="font-semibold text-blue-300 mb-2">CEX Arbitrage — {cexArb.length} pair{cexArb.length > 1 ? 's' : ''}</p>
              <div className="flex flex-wrap gap-2">
                {cexArb.map(a => (
                  <span key={a.coin} className="text-xs font-mono px-2 py-1 rounded border border-blue-700 bg-blue-900/40 text-blue-200">
                    {a.coin}: {EXCHANGE_LABEL[a.low]??a.low} {fmtPrice(a.lowPrice)} vs {EXCHANGE_LABEL[a.high]??a.high} {fmtPrice(a.highPrice)} — <span className="font-bold">{a.spreadPct.toFixed(3)}%</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
        {infoLagMarkets.length > 0 && (
          <div className="rounded-xl border border-orange-700 bg-orange-950/30 p-4 flex gap-3 items-start">
            <span className="text-2xl flex-shrink-0">⚠️</span>
            <div>
              <p className="font-semibold text-orange-300">Information Lag — {infoLagMarkets.length} prediction market{infoLagMarkets.length > 1 ? 's' : ''} may not have priced in Binance move</p>
              <p className="text-orange-400/70 text-sm mt-0.5">Binance price moved ≥3% in the last hour.</p>
            </div>
          </div>
        )}
      </div>

      {/* Live CEX prices */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-xl font-bold">Live Prices — 6 CEX · WebSocket + REST</h2>
          <span className={`text-xs px-2 py-0.5 rounded-full border ${dataStale ? 'border-red-700 bg-red-950/40 text-red-400' : 'border-green-700 bg-green-900/40 text-green-400'}`}>
            {dataStale ? 'stale — agent10 offline?' : `ws live · REST ${Math.round(dataAge / 1000)}s ago`}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
          {coins.map(coin => {
            const bp = bestPrice(coin), chg = change24h(coin), lag = infoLag[coin], up = (chg ?? 0) >= 0;
            const hasFutures = futures.binance?.[coin];
            const fr = hasFutures?.fundingRate ?? null;
            return (
              <div key={coin} className={`rounded-xl border p-3 ${lag ? 'border-orange-700 bg-orange-950/30' : up ? 'border-green-900/50 bg-green-950/20' : 'border-red-900/50 bg-red-950/20'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-base font-bold">{COIN_META[coin].emoji}</span>
                  {lag && <span className="text-xs font-bold px-1 rounded border border-orange-600 bg-orange-900/60 text-orange-300">LAG</span>}
                </div>
                <div className="text-xs text-gray-500">{COIN_META[coin].label}</div>
                {bp != null ? <div className="text-base font-bold tabular-nums mt-1 leading-none">{fmtPrice(bp)}</div> : <div className="text-xs text-gray-600 mt-1">loading…</div>}
                {chg != null && <div className={`text-xs font-semibold mt-0.5 ${up ? 'text-green-400' : 'text-red-400'}`}>{up ? '▲' : '▼'} {Math.abs(chg).toFixed(2)}%</div>}
                {fr != null && <div className={`text-xs mt-0.5 ${fundingClass(fr)}`}>fr {fr > 0 ? '+' : ''}{fr.toFixed(4)}%</div>}
              </div>
            );
          })}
        </div>

        {/* Exchange price table */}
        <div className="rounded-xl border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900/60">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Coin</th>
                {exchangeNames.map(ex => <th key={ex} className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">{EXCHANGE_LABEL[ex]??ex}</th>)}
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Spread</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {coins.map(coin => {
                const prices = exchangeNames.map(ex => ({ ex, p: exchanges[ex]?.[coin]?.price ?? null }));
                const validPrices = prices.filter(x => x.p != null).map(x => x.p!);
                const minP = validPrices.length ? Math.min(...validPrices) : null;
                const maxP = validPrices.length ? Math.max(...validPrices) : null;
                const spread = minP && maxP && minP > 0 ? ((maxP - minP) / minP * 100) : 0;
                const arb = cexArb.find(a => a.coin === coin);
                return (
                  <tr key={coin} className={`hover:bg-white/[0.02] ${arb ? 'bg-blue-950/10' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-gray-100">{COIN_META[coin].emoji} {coin}</span>
                        {arb && <span className="text-xs font-bold px-1 rounded border border-blue-600 bg-blue-900/50 text-blue-300">CEX ARB</span>}
                        {infoLag[coin] && <span className="text-xs font-bold px-1 rounded border border-orange-600 bg-orange-900/50 text-orange-300">LAG</span>}
                      </div>
                    </td>
                    {prices.map(({ ex, p }) => (
                      <td key={ex} className={`px-3 py-3 text-right tabular-nums text-sm ${
                        p == null ? 'text-gray-700' :
                        p === minP && validPrices.length > 1 ? 'text-red-400 font-semibold' :
                        p === maxP && validPrices.length > 1 ? 'text-green-400 font-semibold' : 'text-gray-300'
                      }`}>{p != null ? fmtPrice(p) : '—'}</td>
                    ))}
                    <td className={`px-3 py-3 text-right text-xs font-bold tabular-nums ${spread >= 0.3 ? 'text-blue-400' : spread > 0 ? 'text-gray-500' : 'text-gray-700'}`}>
                      {spread > 0 ? `${spread.toFixed(3)}%` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Perpetual Futures */}
      <section>
        <h2 className="text-xl font-bold mb-4">Perpetual Futures — Funding Rates</h2>
        <div className="rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900/60">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Asset</th>
                {['binance','bybit','okx'].map(ex => (
                  <th key={ex} colSpan={2} className="px-3 py-3 text-center text-xs font-semibold text-gray-500 uppercase border-l border-gray-800">
                    {EXCHANGE_LABEL[ex]??ex} Futures
                  </th>
                ))}
              </tr>
              <tr className="border-b border-gray-800 bg-gray-900/40">
                <th className="px-4 py-2 text-left text-xs text-gray-600" />
                {['binance','bybit','okx'].map(ex => (
                  <>
                    <th key={`${ex}-mark`} className="px-3 py-2 text-right text-xs text-gray-600 border-l border-gray-800">Mark</th>
                    <th key={`${ex}-fr`} className="px-3 py-2 text-right text-xs text-gray-600">Funding/8h</th>
                  </>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {perpCoins.map(coin => {
                const spotPrice = exchanges.binance?.[coin]?.price;
                return (
                  <tr key={coin} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-gray-100">{COIN_META[coin]?.emoji} {coin}</span>
                        {spotPrice && <span className="text-xs text-gray-600">spot {fmtPrice(spotPrice)}</span>}
                      </div>
                    </td>
                    {['binance','bybit','okx'].map(ex => {
                      const info = futures[ex]?.[coin];
                      const fr   = info?.fundingRate;
                      const mark = info?.markPrice;
                      const highFund = fr != null && Math.abs(fr) >= 0.1;
                      return (
                        <>
                          <td key={`${ex}-${coin}-mark`} className="px-3 py-3 text-right tabular-nums text-sm text-gray-300 border-l border-gray-800">
                            {mark ? fmtPrice(mark) : <span className="text-gray-700">—</span>}
                          </td>
                          <td key={`${ex}-${coin}-fr`} className="px-3 py-3 text-right tabular-nums text-sm">
                            {fr != null ? (
                              <span className={`font-mono ${fundingClass(fr)} ${highFund ? 'px-1 rounded border border-current' : ''}`}>
                                {fr > 0 ? '+' : ''}{fr.toFixed(4)}%{highFund && ' 🔥'}
                              </span>
                            ) : <span className="text-gray-700">—</span>}
                          </td>
                        </>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-600 mt-2">Positive funding = longs pay shorts. High funding (&gt;0.1%) = crowded trade risk.</p>
      </section>

      {/* Cash & Carry */}
      {basisTrades.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4">Cash &amp; Carry (Spot vs Perp Arbitrage)</h2>
          <div className="space-y-3">
            {basisTrades.map(b => (
              <div key={b.coin} className="rounded-xl border border-violet-800/50 bg-violet-950/20 p-5">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{COIN_META[b.coin]?.emoji ?? '?'}</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-lg">{b.coin}</span>
                        <span className="text-xs font-bold px-1.5 py-0.5 rounded border border-violet-600 bg-violet-900/60 text-violet-300">CASH &amp; CARRY</span>
                        <span className={`text-xs font-semibold ${b.direction === 'contango' ? 'text-orange-400' : 'text-blue-400'}`}>{b.direction}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">{b.exchange} · market neutral</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-violet-400">{b.basisPct > 0 ? '+' : ''}{b.basisPct.toFixed(3)}%</div>
                    <div className="text-xs text-gray-500">premium</div>
                    {b.annualizedReturn != null && <div className="text-sm font-bold text-emerald-400 mt-1">~{b.annualizedReturn.toFixed(1)}% / yr</div>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm bg-gray-900/60 rounded-lg px-4 py-3 font-mono">
                  {b.direction === 'contango' ? (
                    <>
                      <span className="text-blue-400">Buy {b.coin} spot</span><span className="text-gray-600">at</span><span className="text-white font-bold">{fmtPrice(b.spot)}</span>
                      <span className="text-gray-600 mx-1">|</span>
                      <span className="text-red-400">Sell {b.coin} perp</span><span className="text-gray-600">at</span><span className="text-white font-bold">{fmtPrice(b.futures)}</span>
                      <span className="text-gray-600 mx-1">|</span>
                      <span className="text-green-400 font-bold">Lock {b.basisPct.toFixed(2)}%</span>
                      {b.profitPerUnit != null && <span className="text-yellow-300">(${b.profitPerUnit.toFixed(0)} per {b.coin})</span>}
                    </>
                  ) : (
                    <>
                      <span className="text-blue-400">Buy {b.coin} perp</span><span className="text-gray-600">at</span><span className="text-white font-bold">{fmtPrice(b.futures)}</span>
                      <span className="text-gray-600 mx-1">|</span>
                      <span className="text-red-400">Sell {b.coin} spot</span><span className="text-gray-600">at</span><span className="text-white font-bold">{fmtPrice(b.spot)}</span>
                      <span className="text-gray-600 mx-1">|</span>
                      <span className="text-green-400 font-bold">Lock {Math.abs(b.basisPct).toFixed(2)}% discount</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* DEX prices */}
      {dexSources.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4">DEX Prices</h2>
          <div className="rounded-xl border border-gray-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/60">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Coin</th>
                  {dexSources.map(s => <th key={s} className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">{DEX_LABEL[s]??s}</th>)}
                  <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Binance</th>
                  <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Max Spread</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {coins.filter(coin => dexSources.some(s => dex[s]?.[coin]?.price)).map(coin => {
                  const binRef = exchanges.binance?.[coin]?.price;
                  const dexPrices = dexSources.map(s => dex[s]?.[coin]?.price ?? null);
                  const validDex = dexPrices.filter((p): p is number => p != null && p > 0);
                  const maxSpread = binRef && validDex.length ? Math.max(...validDex.map(p => Math.abs((p - binRef) / binRef * 100))) : null;
                  return (
                    <tr key={coin} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-3 font-bold text-gray-100">{COIN_META[coin]?.emoji} {coin}</td>
                      {dexSources.map((s, i) => {
                        const p = dexPrices[i];
                        const spread = p && binRef ? ((p - binRef) / binRef * 100) : null;
                        return (
                          <td key={s} className="px-3 py-3 text-right tabular-nums">
                            {p ? (
                              <div>
                                <span className="text-gray-300">{fmtPrice(p)}</span>
                                {spread != null && Math.abs(spread) >= 0.1 && (
                                  <span className={`ml-1 text-xs ${spread > 0 ? 'text-green-500' : 'text-red-500'}`}>{spread > 0 ? '+' : ''}{spread.toFixed(2)}%</span>
                                )}
                              </div>
                            ) : <span className="text-gray-700">—</span>}
                          </td>
                        );
                      })}
                      <td className="px-3 py-3 text-right tabular-nums text-gray-400">{binRef ? fmtPrice(binRef) : '—'}</td>
                      <td className={`px-3 py-3 text-right text-xs font-bold tabular-nums ${maxSpread != null && maxSpread >= 0.5 ? 'text-orange-400' : 'text-gray-600'}`}>
                        {maxSpread != null ? `${maxSpread.toFixed(3)}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Crypto prediction markets */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-xl font-bold">Crypto Prediction Markets</h2>
          <span className="text-xs px-2 py-0.5 rounded-full border border-gray-700 text-gray-500">{cryptoMarkets.length} markets · Polymarket + Kalshi</span>
        </div>
        {cryptoMarkets.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-8 text-center">
            <p className="text-gray-500">No crypto markets found on Polymarket or Kalshi right now.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/60">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Market</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Platform</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Asset</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Spot Price</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Mkt Prob</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {cryptoMarkets.map(m => {
                  const binPrice = m.coin ? exchanges.binance?.[m.coin] : null;
                  const platCfg  = m.platform === 'polymarket' ? PLATFORMS.polymarket : PLATFORMS.kalshi;
                  return (
                    <tr key={m.id} className={`hover:bg-white/[0.02] transition-colors ${m.infoLag ? 'bg-orange-950/10' : ''}`}>
                      <td className="px-4 py-3 text-gray-200 max-w-xs">
                        <a href={m.url} target="_blank" rel="noopener noreferrer" className="line-clamp-1 hover:text-white hover:underline">{m.question}</a>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border ${platCfg.badgeClass}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${platCfg.dotClass}`} />{platCfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{m.coin ? (COIN_META[m.coin]?.label ?? m.coin) : '—'}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {binPrice?.price ? <span className={(binPrice.change24hPct ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}>{fmtPrice(binPrice.price)}</span> : <span className="text-gray-600">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`font-bold tabular-nums ${m.probability >= 70 ? 'text-green-400' : m.probability >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>{m.probability}%</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {m.infoLag ? <span className="text-xs font-bold px-1.5 py-0.5 rounded border border-orange-600 bg-orange-900/50 text-orange-300">INFO LAG</span> : <span className="text-xs text-gray-600">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Sports Tab (full detail) ──────────────────────

const SPORT_BADGE: Record<string, string> = {
  'soccer_italy_serie_a':      'border-green-700 bg-green-900/40 text-green-300',
  'soccer_uefa_champs_league': 'border-yellow-700 bg-yellow-900/40 text-yellow-300',
  'basketball_nba':            'border-orange-700 bg-orange-900/40 text-orange-300',
  'americanfootball_nfl':      'border-blue-700 bg-blue-900/40 text-blue-300',
  'tennis_atp_french_open':    'border-rose-700 bg-rose-900/40 text-rose-300',
};

function fmtOdds(o: number) { return o.toFixed(2); }
function fmtTime(iso: string) {
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function SportsTab({ data }: { data: SportsResponse | null }) {
  const [sportFilter, setSportFilter] = useState<string>('all');
  const [arbOnly,     setArbOnly]     = useState(false);

  if (!data || data.dataAge > 3_600_000) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
        <div className="text-5xl mb-4">🏟️</div>
        <p className="text-gray-300 font-semibold text-lg">Loading sports odds…</p>
        <p className="text-gray-600 text-sm mt-2">agent12-sports fetches The Odds API every 5 minutes.</p>
      </div>
    );
  }

  const { sportsMeta, markets, arbOpportunities, totalEvents, totalArb, dataAge } = data;
  const dataStale = dataAge > 600_000;
  const filtered  = markets.filter(m => {
    if (sportFilter !== 'all' && m.sport !== sportFilter) return false;
    if (arbOnly && !m.arbOpportunity) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      {arbOpportunities.length > 0 && (
        <div className="rounded-xl border border-green-700 bg-green-950/30 p-4 flex gap-3 items-start">
          <span className="text-2xl flex-shrink-0">🎯</span>
          <div className="flex-1">
            <p className="font-semibold text-green-300 mb-2">Bookmaker Arbitrage — {totalArb} opportunit{totalArb > 1 ? 'ies' : 'y'} found</p>
            <div className="space-y-2">
              {arbOpportunities.slice(0, 5).map(m => (
                <div key={m.id} className="text-xs font-mono px-3 py-2 rounded border border-green-700 bg-green-900/30 text-green-200 flex flex-wrap items-center gap-2">
                  <span>{m.sportEmoji}</span>
                  <span className="font-bold text-white">{m.homeTeam} vs {m.awayTeam}</span>
                  <span className="text-gray-400">|</span>
                  {m.arbBets.map(b => (
                    <span key={b.outcome}>
                      <span className="text-yellow-300">{b.outcome}</span>
                      <span className="text-gray-400"> @ </span>
                      <span className="text-white font-bold">{fmtOdds(b.odds)}</span>
                      <span className="text-gray-400"> ({b.bookmaker}, stake ${b.stake.toFixed(0)})</span>
                    </span>
                  ))}
                  <span className="text-gray-400">|</span>
                  <span className="text-green-400 font-bold">+{m.arbPct.toFixed(2)}% profit</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-3">
          <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-2 text-center">
            <div className="text-xl font-bold tabular-nums">{totalEvents}</div><div className="text-xs text-gray-500">Events</div>
          </div>
          <div className={`rounded-lg border px-4 py-2 text-center ${totalArb > 0 ? 'border-green-800 bg-green-950/30' : 'border-gray-800 bg-gray-900/40'}`}>
            <div className={`text-xl font-bold tabular-nums ${totalArb > 0 ? 'text-green-400' : ''}`}>{totalArb}</div><div className="text-xs text-gray-500">Arb Opps</div>
          </div>
          <div className={`rounded-lg border px-4 py-2 text-center ${dataStale ? 'border-red-800 bg-red-950/30' : 'border-gray-800 bg-gray-900/40'}`}>
            <div className={`text-sm font-semibold ${dataStale ? 'text-red-400' : 'text-gray-400'}`}>{Math.round(dataAge / 60000)}m ago</div><div className="text-xs text-gray-500">Data age</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 ml-auto">
          <button onClick={() => setArbOnly(v => !v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${arbOnly ? 'border-green-600 bg-green-900/50 text-green-300' : 'border-gray-700 text-gray-500 hover:text-gray-300'}`}>
            🎯 Arb only
          </button>
          {[{ key: 'all', label: 'All Sports' }, ...(sportsMeta ?? []).map(s => ({ key: s.key, label: `${s.emoji} ${s.label}` }))].map(f => (
            <button key={f.key} onClick={() => setSportFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${sportFilter === f.key ? 'border-blue-600 bg-blue-900/50 text-blue-300' : 'border-gray-700 text-gray-500 hover:text-gray-300'}`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
          <div className="text-5xl mb-4">🔎</div>
          <p className="text-gray-300 font-semibold">No events match your filter.</p>
          {arbOnly && totalEvents > 0 && <p className="text-gray-500 text-sm mt-2">No bookmaker arb detected right now.</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(m => (
            <div key={m.id} className={`rounded-xl border p-4 ${m.arbOpportunity ? 'border-green-800 bg-green-950/10' : 'border-gray-800 bg-gray-900/20'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xl">{m.sportEmoji}</span>
                    <span className="font-bold text-white text-base">{m.homeTeam} vs {m.awayTeam}</span>
                    {m.arbOpportunity && <span className="text-xs font-bold px-2 py-0.5 rounded-full border border-green-600 bg-green-900/50 text-green-300">ARB +{m.arbPct.toFixed(2)}%</span>}
                    <span className={`text-xs px-1.5 py-0.5 rounded border ${SPORT_BADGE[m.sport] ?? 'border-gray-700 bg-gray-800 text-gray-400'}`}>{m.sportLabel}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{fmtTime(m.commenceTime)} · {m.bookmakers.length} bookmakers</p>
                </div>
                <div className="text-right text-xs text-gray-500">
                  implied: {(m.impliedSum * 100).toFixed(1)}%
                  {m.impliedSum < 1 && <span className="text-green-400 font-bold ml-1">(under 100% ✓)</span>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {m.bestOdds.map(o => {
                  const arbBet = m.arbBets.find(b => b.outcome === o.name);
                  return (
                    <div key={o.name} className={`rounded-lg border px-3 py-2 text-xs ${arbBet ? 'border-green-700 bg-green-900/20' : 'border-gray-700 bg-gray-800/40'}`}>
                      <div className="text-gray-400 mb-0.5">{o.name}</div>
                      <div className="font-bold text-white tabular-nums text-sm">{fmtOdds(o.price)}</div>
                      <div className="text-gray-500">{o.bookmaker}</div>
                      {arbBet && <div className="text-green-400 mt-0.5">Stake: ${arbBet.stake.toFixed(0)}</div>}
                    </div>
                  );
                })}
              </div>
              {m.arbOpportunity && m.arbBets.length > 0 && (
                <div className="mt-3 rounded-lg border border-green-800 bg-green-950/20 px-3 py-2 text-xs font-mono text-green-200">
                  <span className="font-bold text-green-400 mr-2">ARB ($100):</span>
                  {m.arbBets.map((b, i) => (
                    <span key={b.outcome}>
                      {i > 0 && <span className="text-gray-500 mx-1">|</span>}
                      <span className="text-yellow-300">{b.outcome}</span>
                      <span className="text-gray-400"> @ </span>
                      <span className="text-white">{fmtOdds(b.odds)}</span>
                      <span className="text-gray-400"> on </span>
                      <span className="text-blue-300">{b.bookmaker}</span>
                      <span className="text-gray-400">: $</span>
                      <span className="text-white">{b.stake.toFixed(2)}</span>
                    </span>
                  ))}
                  <span className="text-gray-400 mx-2">→</span>
                  <span className="text-green-400 font-bold">profit: ${m.arbPct.toFixed(2)}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Weather Tab (full detail) ─────────────────────

function WeatherTab({ data }: { data: WeatherResponse | null }) {
  if (!data || data.dataAge > 3_600_000) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
        <div className="text-5xl mb-4">🌤️</div>
        <p className="text-gray-300 font-semibold text-lg">Loading weather markets…</p>
        <p className="text-gray-600 text-sm mt-2">agent13-weather fetches Kalshi weather markets + Open-Meteo forecasts every 10 minutes.</p>
      </div>
    );
  }

  const { markets, forecasts, totalMarkets, dataAge } = data;
  const dataStale = dataAge > 1_200_000;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-2 text-center">
          <div className="text-xl font-bold tabular-nums">{totalMarkets}</div>
          <div className="text-xs text-gray-500">Weather Markets</div>
        </div>
        <div className={`rounded-lg border px-4 py-2 text-center ${dataStale ? 'border-red-800 bg-red-950/30' : 'border-gray-800 bg-gray-900/40'}`}>
          <div className={`text-sm font-semibold ${dataStale ? 'text-red-400' : 'text-gray-400'}`}>{Math.round(dataAge / 60000)}m ago</div>
          <div className="text-xs text-gray-500">Data age</div>
        </div>
        <span className="text-xs text-gray-600 ml-2">Source: Kalshi · Open-Meteo</span>
      </div>

      {forecasts.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4">7-Day Forecasts — Key Cities</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {forecasts.map(city => (
              <div key={city.city} className="rounded-xl border border-gray-800 bg-gray-900/20 p-4">
                <h3 className="font-bold text-white mb-3">{city.city}</h3>
                <div className="space-y-1.5">
                  {city.days.slice(0, 5).map(day => (
                    <div key={day.date} className="flex items-center gap-2 text-xs">
                      <span className="text-gray-500 w-16 flex-shrink-0">
                        {new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                      </span>
                      {day.maxTempF != null && (
                        <span className={`font-bold tabular-nums ${day.maxTempF >= 90 ? 'text-red-400' : day.maxTempF >= 70 ? 'text-yellow-400' : day.maxTempF >= 50 ? 'text-blue-300' : 'text-blue-500'}`}>
                          {Math.round(day.maxTempF)}°F
                        </span>
                      )}
                      {day.minTempF != null && <span className="text-gray-600">/{Math.round(day.minTempF)}°F</span>}
                      {day.precipProbPct != null && day.precipProbPct > 20 && <span className="text-blue-400">💧{day.precipProbPct}%</span>}
                      {day.precipIn != null && day.precipIn > 0.1 && <span className="text-blue-300">{day.precipIn.toFixed(2)}&quot;</span>}
                      {day.maxWindMph != null && day.maxWindMph > 25 && <span className="text-gray-400">💨{Math.round(day.maxWindMph)}mph</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-xl font-bold mb-4">Kalshi Weather Prediction Markets</h2>
        {markets.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-8 text-center">
            <p className="text-gray-500">No active weather markets found on Kalshi right now.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/60">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Market</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Category</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">YES%</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Volume</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {markets.map(m => (
                  <tr key={m.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3 text-gray-200 max-w-xs">
                      <a href={m.url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 hover:text-white hover:underline leading-snug">{m.title}</a>
                      {m.subtitle && <p className="text-xs text-gray-600 mt-0.5 line-clamp-1">{m.subtitle}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-1.5 py-0.5 rounded border border-sky-700 bg-sky-900/40 text-sky-300 capitalize">{m.category}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {m.probability != null ? (
                        <span className={`font-bold tabular-nums ${m.probability >= 70 ? 'text-green-400' : m.probability >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>{m.probability}%</span>
                      ) : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-400">{m.volume != null ? `$${m.volume.toLocaleString()}` : '—'}</td>
                    <td className="px-4 py-3 text-right text-xs text-gray-500">
                      {m.expiresAt ? new Date(m.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
