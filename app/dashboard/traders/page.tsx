'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Lock, Bell, BellOff, UserMinus, UserPlus, AlertCircle, Search, X, ExternalLink, ChevronRight } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LbEntry {
  wallet:          string;
  name:            string;
  pnlUsdc:         number;
  winRate:         number;
  resolvedMarkets: number;
  volumeUsdc:      number;
  lastActive:      number;
  wins:            number;
  losses:          number;
  twoSidedPct?:    number;
  walletType?:     'MM' | 'DIRECTIONAL' | null;
}

interface LbData {
  ok:             boolean;
  stale:          boolean;
  staleMinutes:   number | null;
  updatedAt:      string | null;
  windowDays:     number;
  marketsScanned: number;
  totalWallets:   number;
  minMarketsToRank: number;
  categories:     Record<string, LbEntry[]>;
}

interface FollowedEntry {
  wallet:          string;
  name:            string;
  category:        string;
  followedAt:      number;
  alertsEnabled:   boolean;
  pnlUsdc:         number | null;
  winRate:         number | null;
  resolvedMarkets: number | null;
  volumeUsdc:      number | null;
  lastActive:      number | null;
  wins:            number | null;
  losses:          number | null;
}

interface TradeAlert {
  wallet:      string;
  name:        string;
  category:    string;
  market:      string;
  side:        string;
  outcome:     string;
  price:       number;
  size:        number;
  alertSentAt: number;
}

interface CopyData {
  ok:               boolean;
  online:           boolean;
  walletsMonitored: number;
  recentAlerts:     TradeAlert[];
  wallets:          FollowedEntry[];
  maxWallets:       number;
}

interface RecentTrade {
  title:     string;
  side:      string;
  outcome:   string;
  size:      number;
  price:     number;
  timestamp: number;
}

interface CatBreakdown {
  category: string;
  count:    number;
  pct:      number;
}

interface PnlPoint {
  date:          string;
  cumulativePnl: number;
}

interface OpenPosition {
  conditionId:   string;
  title:         string;
  outcome:       string;
  size:          number;
  avgPrice:      number;
  curPrice:      number;
  currentValue:  number;
  initialValue:  number;
  unrealizedPnl: number;
  unrealizedPct: number;
  endDate:       string | null;
}

interface WalletDetail {
  address:         string;
  name:            string | null;
  notFound:        boolean;
  walletType:      'MM' | 'DIRECTIONAL' | null;
  twoSidedPct:     number;
  twoSidedMarkets: number;
  totalPosMarkets: number;
  resolvedMarkets: number;
  realizedPnl:     number;
  unrealizedPnl:   number;
  estimatedPnl:    number;
  winRate:         number;
  wins:            number;
  losses:          number;
  avgPositionSize: number;
  totalVolume:     number;
  tradeCount:      number;
  firstActive:     number | null;
  lastActive:      number | null;
  portfolioValue:  number | null;
  openPositions:   OpenPosition[];
  pnlHistory:      PnlPoint[];
  categoryBreakdown: CatBreakdown[];
  recentTrades:    RecentTrade[];
  disclaimer:      string;
  error?:          string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = ['All', 'Politics', 'Sports', 'Crypto', 'Pop Culture', 'World', 'Ultra-fast ≤5 min', 'Fast 5–15 min'] as const;
type Category = typeof CATEGORIES[number];

const CAT_META: Record<Category, { emoji: string; desc: string }> = {
  'All':               { emoji: '🏆', desc: 'Top traders across all markets'                           },
  'Politics':          { emoji: '🗳️',  desc: 'Elections, policy, geopolitics'                          },
  'Sports':            { emoji: '⚽',  desc: 'NBA, NFL, Soccer, UFC and more'                          },
  'Crypto':            { emoji: '₿',   desc: 'BTC, ETH, SOL price markets'                            },
  'Pop Culture':       { emoji: '🎬',  desc: 'Entertainment, music, celebrities'                       },
  'World':             { emoji: '🌍',  desc: 'Science, tech, global events'                            },
  'Ultra-fast ≤5 min': { emoji: '⚡',  desc: 'Specialists in markets lasting ≤5 min · not in Fast bucket' },
  'Fast 5–15 min':     { emoji: '⏱',  desc: 'Specialists in 5–15 min markets · excludes ≤5 min traders' },
};

const CAT_COLOR: Record<string, string> = {
  'Politics':    'text-yellow-400/80',
  'Sports':      'text-blue-400/80',
  'Crypto':      'text-orange-400/80',
  'Pop Culture': 'text-pink-400/80',
  'World':       'text-green-400/80',
};

const CAT_BAR_COLOR: Record<string, string> = {
  'Crypto':     'bg-orange-400/70',
  'Sports':     'bg-blue-400/70',
  'Politics':   'bg-yellow-400/70',
  'Pop Culture':'bg-pink-400/70',
  'World':      'bg-green-400/70',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPnl(n: number | null | undefined): string {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  if (Math.abs(n) >= 1_000_000) return sign + '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000)     return sign + '$' + (n / 1_000).toFixed(1) + 'k';
  return sign + '$' + Math.abs(n).toFixed(2);
}

function fmtVol(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(0) + 'k';
  return '$' + n.toFixed(0);
}

function fmtWallet(addr: string): string {
  if (!addr?.startsWith('0x')) return (addr ?? '').slice(0, 12);
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function fmtAge(ts: number | null | undefined): string {
  if (!ts) return '—';
  const secs = Date.now() / 1000 - ts;
  if (secs < 120)         return 'just now';
  if (secs < 3600)        return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400)       return Math.floor(secs / 3600) + 'h ago';
  if (secs < 86400 * 30)  return Math.floor(secs / 86400) + 'd ago';
  if (secs < 86400 * 365) return Math.floor(secs / 86400 / 30) + 'mo ago';
  return Math.floor(secs / 86400 / 365) + 'yr ago';
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function fmtEndDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const today    = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (dateStr === today)    return 'today';
  if (dateStr === tomorrow) return 'tomorrow';
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function wrColor(r: number | null | undefined): string {
  if (r == null) return 'text-text-muted';
  if (r >= 60) return 'text-positive';
  if (r >= 50) return 'text-text-secondary';
  return 'text-negative/70';
}

function displayName(entry: { name?: string; wallet: string }): string {
  return entry.name && !entry.name.startsWith('0x') ? entry.name : fmtWallet(entry.wallet);
}

function matchesSearch(entry: { name?: string; wallet: string }, q: string): boolean {
  if (!q) return true;
  const lq = q.toLowerCase();
  return (entry.name ?? '').toLowerCase().includes(lq) || entry.wallet.toLowerCase().includes(lq);
}

function isWalletAddress(q: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(q.trim());
}

// ── SVG P&L Chart ─────────────────────────────────────────────────────────────

function PnlChart({ history }: { history: PnlPoint[] }) {
  if (history.length < 2) {
    return (
      <div className="h-20 flex items-center justify-center font-mono text-[9px] text-text-muted border border-border/40 bg-bg-elevated/20">
        Not enough resolved positions for a chart ({history.length} data point{history.length !== 1 ? 's' : ''})
      </div>
    );
  }

  const W = 600;
  const H = 80;
  const PAD = { t: 8, b: 8, l: 4, r: 4 };
  const iW = W - PAD.l - PAD.r;
  const iH = H - PAD.t - PAD.b;

  const vals = history.map(p => p.cumulativePnl);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(0, ...vals);
  const range = maxV - minV || 1;

  const toY = (v: number) => PAD.t + iH - ((v - minV) / range) * iH;
  const toX = (i: number) => PAD.l + (i / (history.length - 1)) * iW;

  const pts = history.map((p, i) => `${toX(i)},${toY(p.cumulativePnl)}`).join(' ');
  const zeroY = toY(0);
  const finalPnl = vals[vals.length - 1];
  const lineColor = finalPnl >= 0 ? '#4ade80' : '#f87171';
  const fillColor = finalPnl >= 0 ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)';

  // Filled area path: down from first point, along zero, up to last, back along line
  const firstX = toX(0);
  const lastX  = toX(history.length - 1);
  const areaPts = `${firstX},${zeroY} ${pts} ${lastX},${zeroY}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none">
      {/* Zero baseline */}
      <line x1={PAD.l} y1={zeroY} x2={W - PAD.r} y2={zeroY} stroke="rgba(255,255,255,0.1)" strokeWidth="1"/>
      {/* Fill */}
      <polygon points={areaPts} fill={fillColor}/>
      {/* Line */}
      <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="1.5"/>
      {/* Start dot */}
      <circle cx={toX(0)} cy={toY(vals[0])} r="2" fill={lineColor}/>
      {/* End dot */}
      <circle cx={toX(history.length-1)} cy={toY(vals[history.length-1])} r="2.5" fill={lineColor}/>
    </svg>
  );
}

// ── Wallet detail panel ───────────────────────────────────────────────────────

function WalletDetailPanel({
  detail, loading, error, onClose, onFollow, isFollowed, followPending,
}: {
  detail:        WalletDetail | null;
  loading:       boolean;
  error:         string;
  onClose:       () => void;
  onFollow:      () => void;
  isFollowed:    boolean;
  followPending: boolean;
}) {
  const addr = detail?.address ?? '';

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Sliding panel */}
      <div className="fixed inset-y-0 right-0 w-full sm:w-[680px] bg-bg-base border-l border-border z-50 overflow-y-auto flex flex-col">

        {/* Panel header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-elevated/40 sticky top-0 z-10">
          <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">Wallet Detail</span>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
            <X className="w-4 h-4"/>
          </button>
        </div>

        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="font-mono text-[11px] text-text-muted animate-pulse">Fetching from Polymarket…</div>
          </div>
        )}

        {!loading && error && (
          <div className="p-6">
            <div className="flex items-start gap-2 p-3 border border-negative/40 bg-negative/5">
              <AlertCircle className="w-3.5 h-3.5 text-negative shrink-0 mt-0.5"/>
              <span className="font-mono text-[10px] text-negative">{error}</span>
            </div>
          </div>
        )}

        {!loading && !error && detail && (
          <div className="p-5 space-y-5 flex-1">

            {/* Address header */}
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                {detail.name && (
                  <div className="font-mono text-sm text-text-primary mb-0.5">{detail.name}</div>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[10px] text-text-secondary break-all">{detail.address}</span>
                  <a
                    href={`https://polymarket.com/profile/${detail.address}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-text-muted hover:text-accent transition-colors"
                    title="View on Polymarket"
                  >
                    <ExternalLink className="w-3 h-3"/>
                  </a>
                </div>
                {!detail.name && (
                  <div className="font-mono text-[9px] text-text-muted mt-0.5">No Polymarket username found</div>
                )}
                {/* Classification badge */}
                {detail.walletType && (
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className={[
                      'font-mono text-[8px] px-2 py-0.5 border uppercase tracking-widest',
                      detail.walletType === 'MM'
                        ? 'border-warning/50 text-warning bg-warning/5'
                        : 'border-accent/40 text-accent bg-accent/5',
                    ].join(' ')}>
                      {detail.walletType === 'MM' ? 'MM / NEUTRAL' : 'DIRECTIONAL'}
                    </span>
                    <span className="font-mono text-[8px] text-text-muted">
                      {detail.twoSidedPct.toFixed(0)}% two-sided
                      · {detail.twoSidedMarkets}/{detail.totalPosMarkets} recent markets
                    </span>
                  </div>
                )}
              </div>
              <button
                onClick={onFollow}
                disabled={followPending}
                className={[
                  'flex items-center gap-1.5 px-3 py-1.5 border font-mono text-[9px] uppercase tracking-widest transition-colors shrink-0',
                  isFollowed
                    ? 'border-accent/50 text-accent hover:border-negative/50 hover:text-negative'
                    : 'border-border text-text-muted hover:border-accent/50 hover:text-accent',
                  followPending ? 'opacity-40 cursor-not-allowed' : '',
                ].join(' ')}
              >
                {followPending ? '…'
                  : isFollowed ? <><UserMinus className="w-3 h-3"/>Unfollow</>
                               : <><UserPlus  className="w-3 h-3"/>Follow</>}
              </button>
            </div>
            {/* MM advisory note */}
            {detail.walletType === 'MM' && !detail.notFound && (
              <div className="flex items-start gap-2 px-3 py-2 border border-warning/30 bg-warning/5">
                <AlertCircle className="w-3 h-3 text-warning/70 shrink-0 mt-0.5"/>
                <p className="font-mono text-[9px] text-warning/80 leading-relaxed">
                  Trades both sides of the same market (market making / neutral). This is not a directional signal
                  and is not meant to be copied — P&amp;L reflects spread capture, not outcome prediction.
                </p>
              </div>
            )}

            {/* Not found */}
            {detail.notFound && (
              <div className="p-6 border border-border bg-bg-panel text-center">
                <div className="font-mono text-[11px] text-text-secondary mb-1">No trades found</div>
                <div className="font-mono text-[9px] text-text-muted">
                  This wallet has no recorded Polymarket activity. It may be new or inactive.
                </div>
              </div>
            )}

            {!detail.notFound && (
              <>
                {/* Key stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 border border-border bg-bg-panel p-4">
                  <div>
                    <div className="font-mono text-[9px] text-text-muted uppercase tracking-widest mb-0.5">Total P&amp;L</div>
                    <div className={`font-mono text-sm font-bold tabular-nums ${detail.estimatedPnl >= 0 ? 'text-positive' : 'text-negative'}`}>
                      {fmtPnl(detail.estimatedPnl)}
                    </div>
                    <div className="font-mono text-[8px] text-text-muted mt-0.5 space-y-0.5">
                      <div>
                        <span className="text-text-muted/70">realized </span>
                        <span className={detail.realizedPnl >= 0 ? 'text-positive/80' : 'text-negative/80'}>
                          {fmtPnl(detail.realizedPnl)}
                        </span>
                      </div>
                      {detail.openPositions.length > 0 && (
                        <div>
                          <span className="text-text-muted/70">unrealized </span>
                          <span className={detail.unrealizedPnl >= 0 ? 'text-positive/80' : 'text-negative/80'}>
                            {fmtPnl(detail.unrealizedPnl)}
                          </span>
                          <span className="text-text-muted/50"> ~</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[9px] text-text-muted uppercase tracking-widest mb-0.5">Win Rate</div>
                    <div className={`font-mono text-sm tabular-nums ${wrColor(detail.winRate)}`}>{detail.winRate.toFixed(1)}%</div>
                    <div className="font-mono text-[8px] text-text-muted">{detail.wins}W / {detail.losses}L</div>
                  </div>
                  <div>
                    <div className="font-mono text-[9px] text-text-muted uppercase tracking-widest mb-0.5">Trades</div>
                    <div className="font-mono text-sm text-text-primary tabular-nums">{detail.tradeCount.toLocaleString()}</div>
                    <div className="font-mono text-[8px] text-text-muted">{detail.resolvedMarkets} resolved mkts</div>
                  </div>
                  <div>
                    <div className="font-mono text-[9px] text-text-muted uppercase tracking-widest mb-0.5">Active</div>
                    <div className="font-mono text-[10px] text-text-secondary">{fmtAge(detail.lastActive)}</div>
                    {detail.firstActive && detail.lastActive && detail.firstActive !== detail.lastActive && (
                      <div className="font-mono text-[8px] text-text-muted">since {fmtDate(detail.firstActive)}</div>
                    )}
                  </div>
                </div>

                {/* Secondary stats */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 border border-border bg-bg-panel p-4">
                  <div>
                    <div className="font-mono text-[9px] text-text-muted uppercase tracking-widest mb-0.5">Volume (sample)</div>
                    <div className="font-mono text-[11px] text-text-primary tabular-nums">{fmtVol(detail.totalVolume)}</div>
                  </div>
                  <div>
                    <div className="font-mono text-[9px] text-text-muted uppercase tracking-widest mb-0.5">Avg Trade Size</div>
                    <div className="font-mono text-[11px] text-text-primary tabular-nums">{fmtVol(detail.avgPositionSize)}</div>
                  </div>
                  {detail.portfolioValue != null && (
                    <div>
                      <div className="font-mono text-[9px] text-text-muted uppercase tracking-widest mb-0.5">Portfolio Value</div>
                      <div className="font-mono text-[11px] text-text-primary tabular-nums">${detail.portfolioValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                    </div>
                  )}
                </div>

                {/* Open positions (unrealized) */}
                {detail.openPositions.length > 0 && (
                  <div className="border border-border bg-bg-panel overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-bg-elevated/40">
                      <div>
                        <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted">
                          Open Positions ({detail.openPositions.length})
                        </span>
                        <span className="ml-2 font-mono text-[8px] text-warning/80">· mark-to-market · unrealized · can go to zero</span>
                      </div>
                      <span className={`font-mono text-[9px] font-bold tabular-nums ${detail.unrealizedPnl >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {fmtPnl(detail.unrealizedPnl)} <span className="font-normal text-text-muted">~</span>
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full font-mono min-w-[520px]">
                        <thead>
                          <tr className="border-b border-border/40 bg-bg-elevated/10">
                            <th className="px-3 py-2 text-left text-[8px] text-text-muted font-normal">Market</th>
                            <th className="px-2 py-2 text-left text-[8px] text-text-muted font-normal">Side</th>
                            <th className="px-2 py-2 text-right text-[8px] text-text-muted font-normal">Tokens</th>
                            <th className="px-2 py-2 text-right text-[8px] text-text-muted font-normal">Entry</th>
                            <th className="px-2 py-2 text-right text-[8px] text-text-muted font-normal">Current</th>
                            <th className="px-2 py-2 text-right text-[8px] text-warning/70 font-normal">Unrealized</th>
                            <th className="px-2 py-2 text-right text-[8px] text-text-muted font-normal">Resolves</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.openPositions.map((p, i) => {
                            const pos = p.unrealizedPnl >= 0;
                            const pct = p.unrealizedPct > 0 ? '+' + p.unrealizedPct.toFixed(1) : p.unrealizedPct.toFixed(1);
                            return (
                              <tr key={i} className="border-b border-border/30 hover:bg-bg-elevated/20">
                                <td className="px-3 py-1.5 text-[9px] text-text-secondary max-w-[160px] truncate" title={p.title}>
                                  {p.title}
                                </td>
                                <td className="px-2 py-1.5">
                                  <span className={`text-[8px] font-bold px-1 rounded-sm ${p.outcome === 'Up' || p.outcome === 'Yes' ? 'bg-positive/10 text-positive' : 'bg-negative/10 text-negative'}`}>
                                    {p.outcome}
                                  </span>
                                </td>
                                <td className="px-2 py-1.5 text-[9px] text-text-muted tabular-nums text-right">{p.size.toFixed(1)}</td>
                                <td className="px-2 py-1.5 text-[9px] text-text-muted tabular-nums text-right">${p.avgPrice.toFixed(3)}</td>
                                <td className="px-2 py-1.5 text-[9px] text-text-secondary tabular-nums text-right font-medium">${p.curPrice.toFixed(3)}</td>
                                <td className="px-2 py-1.5 tabular-nums text-right">
                                  <span className={`text-[9px] font-bold ${pos ? 'text-positive' : 'text-negative'}`}>
                                    {fmtPnl(p.unrealizedPnl)}
                                  </span>
                                  <div className={`text-[7px] ${pos ? 'text-positive/70' : 'text-negative/70'}`}>{pct}%</div>
                                </td>
                                <td className="px-2 py-1.5 text-[8px] text-text-muted text-right whitespace-nowrap">
                                  {fmtEndDate(p.endDate)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="px-4 py-2 border-t border-border/30 flex items-center gap-2">
                      <AlertCircle className="w-3 h-3 text-warning/60 shrink-0"/>
                      <span className="font-mono text-[8px] text-text-muted">
                        Prices are live mark-to-market. Unresolved positions can settle at 0 or 1 — unrealized P&amp;L is variable until resolution.
                      </span>
                    </div>
                  </div>
                )}

                {/* Realized P&L chart (closed positions only) */}
                <div className="border border-border bg-bg-panel p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted">
                      Realized P&amp;L · {detail.resolvedMarkets} closed positions
                    </span>
                    <span className={`font-mono text-[9px] font-bold ${detail.realizedPnl >= 0 ? 'text-positive' : 'text-negative'}`}>
                      {fmtPnl(detail.realizedPnl)}
                    </span>
                  </div>
                  <PnlChart history={detail.pnlHistory}/>
                  {detail.pnlHistory.length >= 2 && (
                    <div className="flex justify-between font-mono text-[8px] text-text-muted mt-1">
                      <span>{detail.pnlHistory[0]?.date}</span>
                      <span>{detail.pnlHistory[detail.pnlHistory.length - 1]?.date}</span>
                    </div>
                  )}
                </div>

                {/* Category breakdown */}
                {detail.categoryBreakdown.length > 0 && (
                  <div className="border border-border bg-bg-panel p-4">
                    <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-3">
                      Category Breakdown · {detail.tradeCount} trades
                    </div>
                    <div className="space-y-2">
                      {detail.categoryBreakdown.map(c => (
                        <div key={c.category} className="flex items-center gap-2">
                          <span className="font-mono text-[9px] text-text-muted w-20 shrink-0">{c.category}</span>
                          <div className="flex-1 h-2 bg-bg-elevated rounded-sm overflow-hidden">
                            <div
                              className={`h-full ${CAT_BAR_COLOR[c.category] ?? 'bg-text-muted/40'} rounded-sm`}
                              style={{ width: `${c.pct}%` }}
                            />
                          </div>
                          <span className="font-mono text-[9px] text-text-secondary w-8 text-right tabular-nums">{c.pct}%</span>
                          <span className="font-mono text-[8px] text-text-muted tabular-nums w-10 text-right">({c.count})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Recent trades */}
                {detail.recentTrades.length > 0 && (
                  <div className="border border-border bg-bg-panel overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-border bg-bg-elevated/40">
                      <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted">
                        Recent Trades (last {detail.recentTrades.length})
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full font-mono min-w-[500px]">
                        <thead>
                          <tr className="border-b border-border/40 bg-bg-elevated/10">
                            <th className="px-3 py-2 text-left text-[8px] text-text-muted font-normal">Market</th>
                            <th className="px-2 py-2 text-left text-[8px] text-text-muted font-normal">Side</th>
                            <th className="px-2 py-2 text-left text-[8px] text-text-muted font-normal">Outcome</th>
                            <th className="px-2 py-2 text-right text-[8px] text-text-muted font-normal">Size</th>
                            <th className="px-2 py-2 text-right text-[8px] text-text-muted font-normal">Price</th>
                            <th className="px-2 py-2 text-right text-[8px] text-text-muted font-normal">Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.recentTrades.map((t, i) => {
                            const isBuy = t.side === 'BUY';
                            return (
                              <tr key={i} className="border-b border-border/30 hover:bg-bg-elevated/20">
                                <td className="px-3 py-1.5 text-[9px] text-text-secondary max-w-[180px] truncate" title={t.title}>
                                  {t.title}
                                </td>
                                <td className="px-2 py-1.5">
                                  <span className={`text-[8px] font-bold px-1 rounded-sm ${isBuy ? 'bg-positive/10 text-positive' : 'bg-negative/10 text-negative'}`}>
                                    {t.side}
                                  </span>
                                </td>
                                <td className="px-2 py-1.5 text-[9px] text-text-muted">{t.outcome}</td>
                                <td className="px-2 py-1.5 text-[9px] text-text-secondary tabular-nums text-right">${t.size.toFixed(0)}</td>
                                <td className="px-2 py-1.5 text-[9px] text-text-muted tabular-nums text-right">{t.price.toFixed(3)}</td>
                                <td className="px-2 py-1.5 text-[8px] text-text-muted text-right whitespace-nowrap">{fmtAge(t.timestamp)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Disclaimer */}
                <div className="flex items-start gap-2 p-3 border border-border/50 bg-bg-elevated/20">
                  <AlertCircle className="w-3 h-3 text-text-muted shrink-0 mt-0.5"/>
                  <p className="font-mono text-[8px] text-text-muted leading-relaxed">
                    <strong className="text-text-secondary">Realized P&amp;L</strong> is final (settled markets).{' '}
                    <strong className="text-text-secondary">Unrealized P&amp;L</strong> is mark-to-market and variable — open positions can still resolve to zero.{' '}
                    {detail.disclaimer}
                  </p>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ── Browse row (leaderboard) ──────────────────────────────────────────────────

function BrowseRow({ e, rank, cat, isFollowed, onFollow, pending, onDetail }: {
  e: LbEntry; rank: number; cat: string;
  isFollowed: boolean; onFollow: () => void; pending: boolean;
  onDetail: () => void;
}) {
  const pos = e.pnlUsdc >= 0;
  return (
    <tr
      className="border-b border-border/40 hover:bg-bg-elevated/30 transition-colors duration-75 group cursor-pointer"
      onClick={onDetail}
    >
      <td className="px-3 py-2.5 font-mono text-[10px] text-text-muted tabular-nums w-8 shrink-0">
        {rank <= 3 ? ['🥇','🥈','🥉'][rank-1] : rank}
      </td>
      <td className="px-3 py-2.5 min-w-0 max-w-[160px]">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono text-[11px] text-text-primary truncate">{displayName(e)}</span>
          {e.walletType && (
            <span className={[
              'font-mono text-[7px] px-1 py-px border shrink-0 uppercase tracking-wide',
              e.walletType === 'MM'
                ? 'border-warning/40 text-warning/80'
                : 'border-accent/30 text-accent/70',
            ].join(' ')}>
              {e.walletType === 'MM' ? 'MM' : 'DIR'}
            </span>
          )}
        </div>
        {e.name && !e.name.startsWith('0x') && (
          <div className="font-mono text-[9px] text-text-muted truncate">{fmtWallet(e.wallet)}</div>
        )}
      </td>
      <td className="px-3 py-2.5 tabular-nums text-right pr-4">
        <span className={`font-bold text-[13px] ${pos ? 'text-positive' : 'text-negative'}`}>
          {fmtPnl(e.pnlUsdc)}
        </span>
      </td>
      <td className="px-3 py-2.5 hidden sm:table-cell">
        <span className={`font-mono text-[10px] ${wrColor(e.winRate)}`}>{e.winRate.toFixed(1)}%</span>
        <div className="font-mono text-[8px] text-text-muted">{e.wins}W/{e.losses}L</div>
      </td>
      <td className="px-3 py-2.5 hidden md:table-cell">
        <span className="font-mono text-[10px] text-text-secondary">{e.resolvedMarkets}</span>
        <div className="font-mono text-[8px] text-text-muted">mkts</div>
      </td>
      <td className="px-3 py-2.5 hidden lg:table-cell">
        <span className="font-mono text-[10px] text-text-secondary">{fmtVol(e.volumeUsdc)}</span>
        <div className="font-mono text-[8px] text-text-muted">vol</div>
      </td>
      <td className="px-3 py-2.5 hidden xl:table-cell">
        <span className="font-mono text-[9px] text-text-muted">{fmtAge(e.lastActive)}</span>
      </td>
      <td className="px-3 py-2" onClick={ev => ev.stopPropagation()}>
        <button onClick={onFollow} disabled={pending}
          className={[
            'flex items-center gap-1 px-2 py-1 border font-mono text-[9px] transition-colors whitespace-nowrap',
            isFollowed
              ? 'border-accent/50 text-accent hover:border-negative/50 hover:text-negative'
              : 'border-border text-text-muted hover:border-accent/50 hover:text-accent',
            pending ? 'opacity-40 cursor-not-allowed' : '',
          ].join(' ')}>
          {pending ? '…'
            : isFollowed ? <><UserMinus className="w-2.5 h-2.5"/>Following</>
                         : <><UserPlus  className="w-2.5 h-2.5"/>Follow</>}
        </button>
      </td>
      <td className="px-2 py-2">
        <ChevronRight className="w-3 h-3 text-text-muted/40 group-hover:text-text-muted transition-colors"/>
      </td>
    </tr>
  );
}

function BrowseCard({ e, rank, cat, isFollowed, onFollow, pending, onDetail }: {
  e: LbEntry; rank: number; cat: string;
  isFollowed: boolean; onFollow: () => void; pending: boolean;
  onDetail: () => void;
}) {
  const pos = e.pnlUsdc >= 0;
  return (
    <div
      className="border-b border-border/40 px-4 py-3 hover:bg-bg-elevated/20 cursor-pointer"
      onClick={onDetail}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[10px] text-text-muted w-5 shrink-0">
            {rank <= 3 ? ['🥇','🥈','🥉'][rank-1] : rank}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-text-primary truncate">{displayName(e)}</span>
              {e.walletType && (
                <span className={[
                  'font-mono text-[7px] px-1 py-px border shrink-0 uppercase',
                  e.walletType === 'MM'
                    ? 'border-warning/40 text-warning/80'
                    : 'border-accent/30 text-accent/70',
                ].join(' ')}>
                  {e.walletType === 'MM' ? 'MM' : 'DIR'}
                </span>
              )}
            </div>
            <div className="font-mono text-[9px] text-text-muted">{fmtWallet(e.wallet)}</div>
          </div>
        </div>
        <span className={`font-bold text-sm tabular-nums shrink-0 ${pos ? 'text-positive' : 'text-negative'}`}>
          {fmtPnl(e.pnlUsdc)}
        </span>
      </div>
      <div className="flex gap-3 mt-1.5 ml-7 flex-wrap items-center">
        <span className={`font-mono text-[9px] ${wrColor(e.winRate)}`}>{e.winRate.toFixed(1)}% WR</span>
        <span className="font-mono text-[9px] text-text-muted">{e.resolvedMarkets} mkts</span>
        <span className="font-mono text-[9px] text-text-muted">{fmtVol(e.volumeUsdc)}</span>
        <span className="font-mono text-[9px] text-text-muted">{fmtAge(e.lastActive)}</span>
        <button onClick={ev => { ev.stopPropagation(); onFollow(); }} disabled={pending}
          className={[
            'ml-auto flex items-center gap-1 px-2 py-0.5 border font-mono text-[9px] transition-colors',
            isFollowed ? 'border-accent/50 text-accent' : 'border-border text-text-muted hover:border-accent/40 hover:text-accent',
          ].join(' ')}>
          {pending ? '…' : isFollowed
            ? <><UserMinus className="w-2.5 h-2.5"/>Following</>
            : <><UserPlus  className="w-2.5 h-2.5"/>Follow</>}
        </button>
      </div>
    </div>
  );
}

// ── Followed row ──────────────────────────────────────────────────────────────

function FollowedRow({ f, onUnfollow, onToggle, pending, onDetail }: {
  f: FollowedEntry;
  onUnfollow: () => void; onToggle: () => void; pending: boolean;
  onDetail: () => void;
}) {
  const pos = (f.pnlUsdc ?? 0) >= 0;
  const catColor = CAT_COLOR[f.category] ?? 'text-text-muted';
  return (
    <tr
      className="border-b border-border/40 hover:bg-bg-elevated/30 transition-colors duration-75 cursor-pointer"
      onClick={onDetail}
    >
      <td className="px-3 py-2.5 min-w-0">
        <div className="font-mono text-[11px] text-text-primary">{displayName(f)}</div>
        <div className="font-mono text-[9px] text-text-muted">{fmtWallet(f.wallet)}</div>
      </td>
      <td className="px-3 py-2.5 hidden sm:table-cell">
        <span className={`font-mono text-[9px] uppercase tracking-wide ${catColor}`}>{f.category}</span>
      </td>
      <td className="px-3 py-2.5 tabular-nums text-right pr-4">
        <span className={`font-mono text-[11px] font-bold ${f.pnlUsdc != null ? (pos ? 'text-positive' : 'text-negative') : 'text-text-muted'}`}>
          {fmtPnl(f.pnlUsdc)}
        </span>
        {f.winRate != null && (
          <div className={`font-mono text-[8px] ${wrColor(f.winRate)}`}>{f.winRate.toFixed(0)}% WR</div>
        )}
      </td>
      <td className="px-3 py-2.5 hidden md:table-cell">
        <span className="font-mono text-[9px] text-text-secondary">{fmtVol(f.volumeUsdc)}</span>
      </td>
      <td className="px-3 py-2.5 hidden lg:table-cell">
        <span className="font-mono text-[9px] text-text-muted">{fmtAge(f.lastActive)}</span>
      </td>
      <td className="px-3 py-2" onClick={ev => ev.stopPropagation()}>
        <button onClick={onToggle} disabled={pending}
          title={f.alertsEnabled ? 'Alerts on — click to mute' : 'Alerts off'}
          className={[
            'flex items-center gap-1 px-2 py-1 border font-mono text-[9px] transition-colors whitespace-nowrap',
            f.alertsEnabled
              ? 'border-accent/40 text-accent hover:bg-accent/5'
              : 'border-border text-text-muted',
          ].join(' ')}>
          {f.alertsEnabled ? <><Bell className="w-2.5 h-2.5"/>ON</> : <><BellOff className="w-2.5 h-2.5"/>OFF</>}
        </button>
      </td>
      <td className="px-3 py-2" onClick={ev => ev.stopPropagation()}>
        <button onClick={onUnfollow} disabled={pending}
          className="flex items-center gap-1 px-2 py-1 border border-border/60 font-mono text-[9px] text-text-muted hover:border-negative/40 hover:text-negative transition-colors">
          <UserMinus className="w-2.5 h-2.5"/>Remove
        </button>
      </td>
    </tr>
  );
}

function FollowedCard({ f, onUnfollow, onToggle, pending, onDetail }: {
  f: FollowedEntry;
  onUnfollow: () => void; onToggle: () => void; pending: boolean;
  onDetail: () => void;
}) {
  const pos = (f.pnlUsdc ?? 0) >= 0;
  const catColor = CAT_COLOR[f.category] ?? 'text-text-muted';
  return (
    <div
      className="border-b border-border/40 px-4 py-3 hover:bg-bg-elevated/20 cursor-pointer"
      onClick={onDetail}
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-mono text-[11px] text-text-primary">{displayName(f)}</div>
          <div className="font-mono text-[9px] text-text-muted">{fmtWallet(f.wallet)}</div>
        </div>
        <span className={`font-mono font-bold text-sm tabular-nums ${f.pnlUsdc != null ? (pos ? 'text-positive' : 'text-negative') : 'text-text-muted'}`}>
          {fmtPnl(f.pnlUsdc)}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        <span className={`font-mono text-[9px] uppercase ${catColor}`}>{f.category}</span>
        {f.winRate != null && <span className={`font-mono text-[9px] ${wrColor(f.winRate)}`}>{f.winRate.toFixed(0)}% WR</span>}
        <span className="font-mono text-[9px] text-text-muted">{fmtVol(f.volumeUsdc)}</span>
        <span className="font-mono text-[9px] text-text-muted">{fmtAge(f.lastActive)}</span>
        <button onClick={ev => { ev.stopPropagation(); onToggle(); }} disabled={pending}
          className={[
            'ml-auto flex items-center gap-1 px-2 py-0.5 border font-mono text-[9px]',
            f.alertsEnabled ? 'border-accent/40 text-accent' : 'border-border text-text-muted',
          ].join(' ')}>
          {f.alertsEnabled ? <><Bell className="w-2.5 h-2.5"/>ON</> : <><BellOff className="w-2.5 h-2.5"/>OFF</>}
        </button>
        <button onClick={ev => { ev.stopPropagation(); onUnfollow(); }} disabled={pending}
          className="flex items-center gap-1 px-2 py-0.5 border border-border/60 font-mono text-[9px] text-text-muted hover:text-negative transition-colors">
          <UserMinus className="w-2.5 h-2.5"/>Remove
        </button>
      </div>
    </div>
  );
}

// ── Alert feed row ────────────────────────────────────────────────────────────

function AlertRow({ a }: { a: TradeAlert }) {
  const isBuy = (a.side ?? '').toUpperCase() === 'BUY';
  const catColor = CAT_COLOR[a.category] ?? 'text-text-muted';
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 border-b border-border/30 hover:bg-bg-elevated/20 font-mono">
      <div className="shrink-0 w-12 text-[9px] text-text-muted tabular-nums pt-0.5">{fmtAge(a.alertSentAt)}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-text-primary">{a.name || fmtWallet(a.wallet)}</span>
          <span className={`text-[9px] font-bold px-1 rounded-sm ${isBuy ? 'bg-positive/10 text-positive' : 'bg-negative/10 text-negative'}`}>
            {(a.side ?? '').toUpperCase()} {a.outcome}
          </span>
          <span className="text-[9px] text-text-muted">@ ${(a.price ?? 0).toFixed(3)}</span>
          <span className="text-[9px] text-text-secondary font-bold">${(a.size ?? 0).toFixed(0)}</span>
        </div>
        <div className="text-[9px] text-text-muted truncate mt-0.5 max-w-[380px]">{a.market}</div>
      </div>
      <span className={`shrink-0 font-mono text-[8px] uppercase ${catColor}`}>{a.category}</span>
    </div>
  );
}

// ── Add wallet inline form ─────────────────────────────────────────────────────

function AddWalletForm({ onAdd }: { onAdd: (wallet: string, name: string) => Promise<void> }) {
  const [open,    setOpen]    = useState(false);
  const [addr,    setAddr]    = useState('');
  const [label,   setLabel]   = useState('');
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState('');

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!addr.trim().startsWith('0x')) { setErr('Must start with 0x'); return; }
    setLoading(true); setErr('');
    try { await onAdd(addr.trim(), label.trim()); setOpen(false); setAddr(''); setLabel(''); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }

  if (!open) return (
    <button onClick={() => setOpen(true)}
      className="flex items-center gap-1.5 px-3 py-1.5 border border-accent/40 text-accent font-mono text-[9px] uppercase tracking-widest hover:bg-accent/5 transition-colors shrink-0">
      <UserPlus className="w-3 h-3"/>Follow wallet
    </button>
  );

  return (
    <form onSubmit={submit} className="flex items-center gap-2 flex-wrap">
      <input type="text" value={addr} onChange={e => setAddr(e.target.value)}
        placeholder="0x wallet address" autoFocus
        className="font-mono text-[10px] bg-bg-elevated border border-border px-2 py-1.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60 w-44"/>
      <input type="text" value={label} onChange={e => setLabel(e.target.value)}
        placeholder="label (optional)"
        className="font-mono text-[10px] bg-bg-elevated border border-border px-2 py-1.5 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/60 w-24"/>
      <button type="submit" disabled={loading}
        className="px-3 py-1.5 bg-accent text-white font-mono text-[10px] uppercase hover:bg-accent-bright transition-colors disabled:opacity-50">
        {loading ? '…' : 'Follow'}
      </button>
      <button type="button" onClick={() => { setOpen(false); setErr(''); }}
        className="px-2 py-1.5 border border-border font-mono text-[10px] text-text-muted hover:text-text-primary transition-colors">
        Cancel
      </button>
      {err && <span className="font-mono text-[9px] text-negative">{err}</span>}
    </form>
  );
}

// ── Locked auto-copy panel ────────────────────────────────────────────────────

function LockedPanel() {
  const steps = [
    { n: 1, label: 'Follow + Alerts',    desc: 'Active now — zero keys, read-only, Telegram only',  done: true  },
    { n: 2, label: 'Security Hardening', desc: 'Non-custodial vault + 2FA before any execution',    done: false },
    { n: 3, label: 'Opt-In Auto-Copy',   desc: 'Explicit activation per trader, per size limit',    done: false },
  ];
  return (
    <div className="mt-6 border border-border bg-bg-panel overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-elevated/40">
        <div className="flex items-center gap-2">
          <Lock className="w-3.5 h-3.5 text-text-muted"/>
          <span className="font-mono text-[11px] uppercase tracking-widest text-text-muted">Auto-Copy Execution</span>
        </div>
        <span className="font-mono text-[9px] px-2 py-0.5 border border-border text-text-muted uppercase tracking-widest bg-bg-elevated">LOCKED</span>
      </div>
      <div className="p-5">
        <div className="flex items-center gap-3 mb-5 pb-4 border-b border-border/50">
          <div className="w-10 h-5 rounded-full bg-border/30 flex items-center px-0.5 cursor-not-allowed select-none">
            <div className="w-4 h-4 rounded-full bg-text-muted/40"/>
          </div>
          <span className="font-mono text-[11px] text-text-muted">Enable auto-copy execution</span>
          <Lock className="w-3 h-3 text-text-muted/60 ml-auto"/>
        </div>
        <div className="space-y-4">
          {steps.map(({ n, label, desc, done }) => (
            <div key={n} className="flex items-start gap-3">
              <div className={`shrink-0 w-5 h-5 rounded-full border flex items-center justify-center mt-0.5 text-[9px]
                ${done ? 'border-positive/60 bg-positive/10 text-positive' : 'border-border text-text-muted'}`}>
                {done ? '✓' : <Lock className="w-2.5 h-2.5"/>}
              </div>
              <div>
                <div className={`font-mono text-[11px] ${done ? 'text-text-primary' : 'text-text-muted'}`}>
                  {n}. {label}{done && <span className="ml-2 text-[9px] text-positive/70 font-normal">active</span>}
                </div>
                <div className="font-mono text-[9px] text-text-muted mt-0.5">{desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 p-3 bg-bg-elevated/50 border border-border/60">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-3 h-3 text-text-muted shrink-0 mt-0.5"/>
            <p className="font-mono text-[9px] text-text-muted leading-relaxed">
              <strong className="text-text-secondary">No keys collected — ever.</strong> Not now, not at any step.
              Alerts = Telegram notifications only. Auto-copy (step 3) requires explicit opt-in per trader and size limit.
              Copy trading has slippage and timing risk. Past P&amp;L ≠ future results. Not financial advice.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = 'browse' | 'following';

export default function TradersPage() {
  const [tab,           setTab]          = useState<Tab>('browse');
  const [cat,           setCat]          = useState<Category>('All');
  const [search,        setSearch]       = useState('');
  const [typeFilter,    setTypeFilter]   = useState<'all' | 'DIRECTIONAL' | 'MM'>('all');
  const [lbData,        setLbData]       = useState<LbData | null>(null);
  const [copyData,      setCopyData]     = useState<CopyData | null>(null);
  const [followLoading, setFollowLoading] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error,         setError]        = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Wallet detail panel state
  const [detailOpen,    setDetailOpen]    = useState(false);
  const [detailWallet,  setDetailWallet]  = useState('');
  const [detailData,    setDetailData]    = useState<WalletDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError,   setDetailError]   = useState('');

  // Polling
  const loadLb = useCallback(async () => {
    try { setLbData(await (await fetch('/api/leaderboard')).json()); }
    catch (e: any) { setError(e.message); }
  }, []);

  const loadCopy = useCallback(async () => {
    try { setCopyData(await (await fetch('/api/copy')).json()); }
    catch {}
  }, []);

  useEffect(() => {
    loadLb(); loadCopy();
    const t1 = setInterval(loadLb,   60_000);
    const t2 = setInterval(loadCopy, 30_000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [loadLb, loadCopy]);

  // Follow set derived from copyData
  const followedSet = new Set((copyData?.wallets ?? []).map(w => w.wallet));
  const followedCount = copyData?.wallets?.length ?? 0;

  // Open wallet detail panel
  async function openDetail(address: string) {
    const addr = address.toLowerCase().trim();
    setDetailWallet(addr);
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailError('');
    setDetailData(null);
    try {
      const r = await fetch(`/api/wallet/${addr}`);
      const d = await r.json();
      if (!r.ok) setDetailError(d.error || 'Failed to load wallet');
      else setDetailData(d);
    } catch (e: any) {
      setDetailError(e.message || 'Network error');
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setDetailOpen(false);
    setDetailData(null);
    setDetailError('');
  }

  // Follow / unfollow (used from detail panel too)
  async function toggleFollow(wallet: string, name: string, category: string) {
    setFollowLoading(prev => new Set(prev).add(wallet));
    const action = followedSet.has(wallet) ? 'unfollow' : 'follow';
    try {
      await fetch('/api/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, wallet, name, category }),
      });
      await loadCopy();
    } catch {}
    finally { setFollowLoading(prev => { const n = new Set(prev); n.delete(wallet); return n; }); }
  }

  // Alert toggle / unfollow
  async function copyAction(action: string, wallet: string) {
    setActionLoading(wallet);
    try {
      await fetch('/api/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, wallet }),
      });
      await loadCopy();
    } catch {}
    finally { setActionLoading(null); }
  }

  async function addWallet(wallet: string, name: string) {
    const r = await fetch('/api/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'follow', wallet, name, category: 'Unknown' }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    await loadCopy();
  }

  // Search key handler — Enter on a valid wallet address opens detail
  function handleSearchKey(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key === 'Enter' && isWalletAddress(search)) {
      openDetail(search.trim());
    }
  }

  const isSearchAddr = isWalletAddress(search);

  // Browse data — filtered
  const allTraders = lbData?.categories?.[cat] ?? [];
  const traders = isSearchAddr ? [] : allTraders.filter(e => {
    if (!matchesSearch(e, search)) return false;
    if (typeFilter === 'MM')          return e.walletType === 'MM';
    if (typeFilter === 'DIRECTIONAL') return e.walletType === 'DIRECTIONAL';
    return true; // 'all' shows everything including unclassified
  });
  const warmingUp = !lbData || (!lbData.ok && !lbData.updatedAt);

  // Following data
  const followed = copyData?.wallets ?? [];
  const filteredFollowed = followed.filter(f => matchesSearch(f, search));
  const alerts = copyData?.recentAlerts ?? [];

  return (
    <div className="max-w-[1100px] mx-auto px-4 py-6">

      {/* Wallet detail panel (when open) */}
      {detailOpen && (
        <WalletDetailPanel
          detail={detailData}
          loading={detailLoading}
          error={detailError}
          onClose={closeDetail}
          onFollow={() => toggleFollow(
            detailData?.address ?? detailWallet,
            detailData?.name ?? '',
            'Unknown',
          )}
          isFollowed={followedSet.has(detailData?.address ?? detailWallet)}
          followPending={followLoading.has(detailData?.address ?? detailWallet)}
        />
      )}

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-mono text-sm uppercase tracking-widest text-text-primary">TRADERS</h1>
          <p className="font-mono text-[10px] text-text-muted mt-0.5">
            Polymarket · realized P&amp;L · {lbData?.windowDays ?? 730}d window ·{' '}
            {lbData?.totalWallets ?? 0} wallets ranked · {lbData?.marketsScanned ?? 0} markets scanned
          </p>
        </div>
        <div className="flex flex-col items-end gap-0.5 font-mono text-[9px]">
          {lbData?.stale && (
            <span className="text-warning">data {lbData.staleMinutes}m old · refreshing</span>
          )}
          <span className={copyData?.online ? 'text-positive/70' : 'text-text-muted'}>
            alert agent {copyData?.online ? 'online' : 'starting…'}
          </span>
        </div>
      </div>

      {/* ── Search ──────────────────────────────────────────────────────────── */}
      <div className="relative mb-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted pointer-events-none"/>
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={handleSearchKey}
          placeholder="Search by trader name or wallet address — paste 0x… and press Enter to look up"
          className="w-full font-mono text-[11px] bg-bg-elevated border border-border pl-8 pr-8 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
        />
        {search && (
          <button onClick={() => { setSearch(''); searchRef.current?.focus(); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary">
            <X className="w-3.5 h-3.5"/>
          </button>
        )}
      </div>
      {/* Address lookup hint */}
      {isSearchAddr ? (
        <div className="mb-3 flex items-center gap-2">
          <button
            onClick={() => openDetail(search.trim())}
            className="flex items-center gap-1.5 px-3 py-1 border border-accent/50 text-accent font-mono text-[9px] uppercase tracking-widest hover:bg-accent/5 transition-colors"
          >
            <Search className="w-3 h-3"/>Look up {fmtWallet(search.trim())} on Polymarket ↗
          </button>
          <span className="font-mono text-[8px] text-text-muted">or press Enter</span>
        </div>
      ) : (
        <div className="mb-3"/>
      )}

      {/* ── Main tabs ───────────────────────────────────────────────────────── */}
      <div className="flex gap-0 border-b border-border mb-4">
        {(['browse', 'following'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={[
              'px-4 py-2 font-mono text-[10px] uppercase tracking-widest transition-colors duration-100 relative',
              tab === t ? 'text-accent' : 'text-text-muted hover:text-text-secondary',
            ].join(' ')}>
            {t === 'browse' ? `Browse (${allTraders.length})` : `Following (${followedCount})`}
            {tab === t && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent"/>}
          </button>
        ))}
        {lbData?.updatedAt && !lbData.stale && (
          <span className="ml-auto self-center font-mono text-[9px] text-text-muted pr-1">
            updated {new Date(lbData.updatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 border border-negative/40 bg-negative/5 font-mono text-[9px] text-negative">
          {error}
        </div>
      )}

      {/* ════════════════════════ BROWSE TAB ════════════════════════ */}
      {tab === 'browse' && (
        <>
          {/* Category tabs */}
          <div className="flex gap-1 mb-3 overflow-x-auto pb-1 scrollbar-none">
            {CATEGORIES.map(c => {
              const count  = lbData?.categories?.[c]?.length ?? 0;
              const active = c === cat;
              return (
                <button key={c} onClick={() => setCat(c)}
                  className={[
                    'flex items-center gap-1.5 px-3 py-1.5 border font-mono text-[10px] uppercase tracking-widest whitespace-nowrap transition-colors shrink-0',
                    active ? 'border-accent bg-accent/10 text-accent'
                           : 'border-border text-text-muted hover:border-accent/30 hover:text-text-secondary',
                  ].join(' ')}>
                  <span>{CAT_META[c].emoji}</span>
                  <span>{c}</span>
                  {count > 0 && (
                    <span className={`text-[8px] px-1 py-0.5 rounded-sm ${active ? 'bg-accent/20 text-accent' : 'bg-border/40 text-text-muted'}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {/* Type filter toggle */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {(['all', 'DIRECTIONAL', 'MM'] as const).map(f => {
              const labels = { all: 'All Types', DIRECTIONAL: 'Directional', MM: 'MM / Neutral' } as const;
              const active = typeFilter === f;
              return (
                <button key={f} onClick={() => setTypeFilter(f)}
                  className={[
                    'px-2.5 py-1 border font-mono text-[9px] uppercase tracking-widest transition-colors',
                    active
                      ? f === 'MM'
                        ? 'border-warning/60 text-warning bg-warning/5'
                        : f === 'DIRECTIONAL'
                          ? 'border-accent text-accent bg-accent/5'
                          : 'border-border text-text-primary bg-bg-elevated/40'
                      : 'border-border/60 text-text-muted hover:border-border hover:text-text-secondary',
                  ].join(' ')}>
                  {labels[f]}
                </button>
              );
            })}
            {typeFilter === 'DIRECTIONAL' && (
              <span className="font-mono text-[8px] text-text-muted">directional = copy-worthy · MM = observe only</span>
            )}
            {typeFilter === 'MM' && (
              <span className="font-mono text-[8px] text-warning/70">trades both sides — not a directional signal</span>
            )}
          </div>
          <p className="font-mono text-[9px] text-text-muted mb-3">
            {CAT_META[cat].desc} · min {lbData?.minMarketsToRank ?? 5} resolved markets to rank
            {search && !isSearchAddr && ` · ${traders.length} matching "${search}"`}
            {isSearchAddr && ' · paste complete address above then press Enter to look up'}
          </p>

          {/* Warming up */}
          {warmingUp && (
            <div className="border border-border bg-bg-panel p-8 text-center">
              <div className="font-mono text-[11px] text-text-secondary mb-2">Agent warming up — scanning resolved markets…</div>
              <div className="font-mono text-[9px] text-text-muted">First data in ~2–3 min. Rankings deepen over time.</div>
            </div>
          )}

          {/* No results */}
          {!warmingUp && !isSearchAddr && traders.length === 0 && (
            <div className="border border-border bg-bg-panel p-8 text-center">
              <div className="font-mono text-[11px] text-text-secondary mb-1">
                {search ? `No traders matching "${search}" in ${cat}` : `No traders ranked in ${cat} yet`}
              </div>
              {search && (
                <button onClick={() => setSearch('')}
                  className="mt-2 font-mono text-[9px] text-accent hover:underline">Clear search</button>
              )}
            </div>
          )}

          {/* Desktop table */}
          {!warmingUp && !isSearchAddr && traders.length > 0 && (
            <>
              <div className="hidden sm:block border border-border bg-bg-panel overflow-hidden">
                <table className="w-full font-mono">
                  <thead>
                    <tr className="border-b border-border bg-bg-elevated/30">
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal w-8">#</th>
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal">Trader</th>
                      <th className="px-3 py-2 text-right text-[9px] uppercase tracking-widest text-positive font-normal pr-4">P&amp;L ↓</th>
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal hidden sm:table-cell">Win Rate</th>
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal hidden md:table-cell">Mkts</th>
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal hidden lg:table-cell">Volume</th>
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal hidden xl:table-cell">Active</th>
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-accent font-normal">Follow</th>
                      <th className="w-6"/>
                    </tr>
                  </thead>
                  <tbody>
                    {traders.map((e, i) => (
                      <BrowseRow key={e.wallet} e={e} rank={i + 1} cat={cat}
                        isFollowed={followedSet.has(e.wallet)}
                        onFollow={() => toggleFollow(e.wallet, e.name, cat)}
                        pending={followLoading.has(e.wallet)}
                        onDetail={() => openDetail(e.wallet)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="sm:hidden border border-border bg-bg-panel overflow-hidden">
                <div className="border-b border-border px-4 py-2 flex justify-between">
                  <span className="font-mono text-[9px] text-text-muted uppercase tracking-widest">Trader</span>
                  <span className="font-mono text-[9px] text-positive uppercase tracking-widest">P&amp;L ↓</span>
                </div>
                {traders.map((e, i) => (
                  <BrowseCard key={e.wallet} e={e} rank={i + 1} cat={cat}
                    isFollowed={followedSet.has(e.wallet)}
                    onFollow={() => toggleFollow(e.wallet, e.name, cat)}
                    pending={followLoading.has(e.wallet)}
                    onDetail={() => openDetail(e.wallet)}
                  />
                ))}
              </div>
            </>
          )}

          {/* Stats */}
          {!warmingUp && (
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 border border-border bg-bg-panel p-4">
              {[
                { label: 'Markets',    value: lbData?.marketsScanned ?? 0   },
                { label: 'Wallets',    value: lbData?.totalWallets   ?? 0   },
                { label: 'Window',     value: (lbData?.windowDays ?? 730) + 'd' },
                { label: 'Min mkts',   value: lbData?.minMarketsToRank ?? 5 },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div className="font-mono text-[9px] text-text-muted uppercase tracking-widest">{label}</div>
                  <div className="font-mono text-sm text-text-primary tabular-nums">{value}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ════════════════════════ FOLLOWING TAB ════════════════════════ */}
      {tab === 'following' && (
        <>
          {/* Header row */}
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <p className="font-mono text-[9px] text-text-muted">
              {followedCount}/{copyData?.maxWallets ?? 50} slots used · alerts via Telegram + shown below
            </p>
            <AddWalletForm onAdd={addWallet}/>
          </div>

          {/* Followed list */}
          {followed.length === 0 ? (
            <div className="border border-border bg-bg-panel p-8 text-center">
              <div className="font-mono text-[11px] text-text-secondary mb-2">No traders followed yet</div>
              <div className="font-mono text-[9px] text-text-muted mb-4">
                Switch to Browse to follow traders from the leaderboard, or paste a wallet address above.
              </div>
              <button onClick={() => setTab('browse')}
                className="px-3 py-2 border border-accent/40 text-accent font-mono text-[10px] uppercase tracking-wider hover:bg-accent/5 transition-colors">
                Browse Leaderboard
              </button>
            </div>
          ) : (
            <>
              {/* Desktop */}
              <div className="hidden sm:block border border-border bg-bg-panel overflow-hidden">
                <table className="w-full font-mono">
                  <thead>
                    <tr className="border-b border-border bg-bg-elevated/30">
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal">Trader</th>
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal hidden sm:table-cell">Category</th>
                      <th className="px-3 py-2 text-right text-[9px] uppercase tracking-widest text-positive font-normal pr-4">P&amp;L</th>
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal hidden md:table-cell">Volume</th>
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal hidden lg:table-cell">Active</th>
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-accent font-normal">Alerts</th>
                      <th className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-text-muted font-normal">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFollowed.map(f => (
                      <FollowedRow key={f.wallet} f={f}
                        onUnfollow={() => copyAction('unfollow', f.wallet)}
                        onToggle={() => copyAction('toggle_alerts', f.wallet)}
                        pending={actionLoading === f.wallet}
                        onDetail={() => openDetail(f.wallet)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Mobile */}
              <div className="sm:hidden border border-border bg-bg-panel overflow-hidden">
                {filteredFollowed.map(f => (
                  <FollowedCard key={f.wallet} f={f}
                    onUnfollow={() => copyAction('unfollow', f.wallet)}
                    onToggle={() => copyAction('toggle_alerts', f.wallet)}
                    pending={actionLoading === f.wallet}
                    onDetail={() => openDetail(f.wallet)}
                  />
                ))}
              </div>
              {search && filteredFollowed.length === 0 && (
                <div className="border border-border bg-bg-panel p-6 text-center font-mono text-[10px] text-text-muted">
                  No followed traders matching "{search}"
                </div>
              )}
            </>
          )}

          {/* Alerts feed */}
          <div className="mt-5 border border-border bg-bg-panel overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-bg-elevated/40">
              <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
                Recent Trade Alerts ({alerts.length})
              </span>
              <span className="font-mono text-[9px] text-text-muted">Telegram + shown here</span>
            </div>
            {alerts.length === 0 ? (
              <div className="px-4 py-8 text-center font-mono text-[10px] text-text-muted">
                {followed.length === 0
                  ? 'Follow a trader to receive alerts'
                  : 'No alerts yet — fires when followed traders make new Polymarket trades'}
              </div>
            ) : (
              alerts.slice(0, 40).map((a, i) => <AlertRow key={i} a={a}/>)
            )}
          </div>
        </>
      )}

      {/* ── Locked panel (always) ──────────────────────────────────────────── */}
      <LockedPanel/>

      {/* Footer */}
      <p className="mt-5 font-mono text-[9px] text-text-muted border-t border-border/50 pt-3 leading-relaxed">
        Leaderboard from on-chain resolved Polymarket markets. P&amp;L estimated from trade data — may differ from actual
        balances (partial fills, gas, open positions). Wallet addresses are public identifiers; following grants no access.
        Alerts reflect observed trades; manual copy has slippage + timing risk. Past performance ≠ future results. Not financial advice.
      </p>

    </div>
  );
}
