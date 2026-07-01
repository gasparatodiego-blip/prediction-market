'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Lock, Bell, BellOff, UserMinus, UserPlus, AlertCircle, Search, X, ExternalLink, ChevronRight } from 'lucide-react';
import Eyebrow        from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import StatCard       from '@/app/components/ui/StatCard';
import EdgeChip       from '@/app/components/ui/EdgeChip';
import PlatformLogo   from '@/components/PlatformLogo';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LbEntry {
  wallet:          string;
  name:            string;
  pnlUsdc:         number;
  winRate:         number;
  wilsonScore?:    number;
  lowSample?:      boolean;
  resolvedMarkets: number;
  volumeUsdc:      number;
  lastActive:      number;
  wins:            number;
  losses:          number;
  twoSidedMkts?:   number;
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
  categories:    Record<string, LbEntry[]>;
  mmCategories?: Record<string, LbEntry[]>;
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
  'Politics':    'text-gold',
  'Sports':      'text-violet',
  'Crypto':      'text-coral-ink',
  'Pop Culture': 'text-mint',
  'World':       'text-mint-deep',
};

const CAT_BAR_COLOR: Record<string, string> = {
  'Crypto':     'bg-coral-ink/60',
  'Sports':     'bg-violet/60',
  'Politics':   'bg-gold/60',
  'Pop Culture':'bg-mint/60',
  'World':      'bg-mint-deep/60',
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
  if (r == null) return 'text-muted';
  if (r >= 60) return 'text-mint-deep';
  if (r >= 50) return 'text-ink-2';
  return 'text-coral-ink/70';
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

// ── Low-sample badge ──────────────────────────────────────────────────────────

function LowSampleBadge() {
  return (
    <span
      className="font-body text-[9px] font-medium px-1.5 py-0.5 rounded-md bg-gold-tint text-gold border border-gold/25 whitespace-nowrap"
      title="Low sample — fewer than the minimum resolved markets; win rate not yet reliable"
    >
      low sample
    </span>
  );
}

// ── Wallet type badge ─────────────────────────────────────────────────────────

function WalletTypeBadge({ type }: { type: 'MM' | 'DIRECTIONAL' }) {
  return (
    <span className={[
      'font-body text-[9px] font-medium px-1.5 py-[2px] rounded-md border uppercase tracking-wide',
      type === 'MM'
        ? 'border-gold/40 text-gold bg-gold-tint'
        : 'border-violet/40 text-violet bg-violet-tint',
    ].join(' ')}>
      {type === 'MM' ? 'MM' : 'DIR'}
    </span>
  );
}

// ── SVG P&L Chart ─────────────────────────────────────────────────────────────

function PnlChart({ history }: { history: PnlPoint[] }) {
  if (history.length < 2) {
    return (
      <div className="h-20 flex items-center justify-center font-body text-[11px] text-muted border border-line bg-bg-soft">
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
  const lineColor = finalPnl >= 0 ? '#0A9D6B' : '#D5552F';
  const fillColor = finalPnl >= 0 ? 'rgba(10,157,107,0.09)' : 'rgba(213,85,47,0.09)';

  const firstX = toX(0);
  const lastX  = toX(history.length - 1);
  const areaPts = `${firstX},${zeroY} ${pts} ${lastX},${zeroY}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none">
      <line x1={PAD.l} y1={zeroY} x2={W - PAD.r} y2={zeroY} stroke="rgba(227,236,231,0.9)" strokeWidth="1"/>
      <polygon points={areaPts} fill={fillColor}/>
      <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="1.5"/>
      <circle cx={toX(0)} cy={toY(vals[0])} r="2" fill={lineColor}/>
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
  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-ink/40 z-40" onClick={onClose} />

      {/* Sliding panel */}
      <div className="fixed inset-y-0 right-0 w-full sm:w-[680px] bg-surface border-l border-line z-50 overflow-y-auto flex flex-col">

        {/* Panel header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-bg-soft sticky top-0 z-10">
          <span className="font-body font-medium text-[11px] uppercase tracking-widest text-muted">Wallet Detail</span>
          <button onClick={onClose} className="text-muted hover:text-ink transition-colors">
            <X className="w-4 h-4"/>
          </button>
        </div>

        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="font-body text-sm text-muted animate-pulse">Fetching from Polymarket…</div>
          </div>
        )}

        {!loading && error && (
          <div className="p-6">
            <div className="flex items-start gap-2 p-3 border border-coral-ink/30 bg-coral-tint rounded-card">
              <AlertCircle className="w-3.5 h-3.5 text-coral-ink shrink-0 mt-0.5"/>
              <span className="font-body text-[11px] text-coral-ink">{error}</span>
            </div>
          </div>
        )}

        {!loading && !error && detail && (
          <div className="p-5 space-y-5 flex-1">

            {/* Address header */}
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                {detail.name && (
                  <div className="font-body font-semibold text-sm text-ink mb-0.5">{detail.name}</div>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-body text-[11px] text-ink-2 break-all">{detail.address}</span>
                  <a
                    href={`https://polymarket.com/profile/${detail.address}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-muted hover:text-violet transition-colors"
                    title="View on Polymarket"
                  >
                    <ExternalLink className="w-3 h-3"/>
                  </a>
                </div>
                {!detail.name && (
                  <div className="font-body text-[10px] text-muted mt-0.5">No Polymarket username found</div>
                )}
                {detail.walletType && (
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <WalletTypeBadge type={detail.walletType} />
                    <span className="font-body text-[10px] text-muted">
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
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-button border font-body text-[10px] font-medium uppercase tracking-wide transition-colors shrink-0',
                  isFollowed
                    ? 'border-violet/50 text-violet bg-violet-tint hover:border-coral-ink/50 hover:text-coral-ink hover:bg-coral-tint'
                    : 'border-line text-muted hover:border-violet/50 hover:text-violet hover:bg-violet-tint',
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
              <div className="flex items-start gap-2 px-3 py-2 border border-gold/25 bg-gold-tint rounded-card">
                <AlertCircle className="w-3 h-3 text-gold shrink-0 mt-0.5"/>
                <p className="font-body text-[11px] text-gold leading-relaxed">
                  Trades both sides of the same market (market making / neutral). This is not a directional signal
                  and is not meant to be copied — P&amp;L reflects spread capture, not outcome prediction.
                </p>
              </div>
            )}

            {/* Not found */}
            {detail.notFound && (
              <div className="p-6 border border-line bg-bg-soft rounded-card text-center">
                <div className="font-body text-sm text-ink-2 mb-1">No trades found</div>
                <div className="font-body text-[11px] text-muted">
                  This wallet has no recorded Polymarket activity. It may be new or inactive.
                </div>
              </div>
            )}

            {!detail.notFound && (
              <>
                {/* Key stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 border border-line bg-bg-soft rounded-card p-4">
                  <div>
                    <div className="font-body text-[10px] text-muted uppercase tracking-wide mb-0.5">Total P&amp;L</div>
                    <div className={`font-display font-bold text-lg tabular-nums leading-none ${detail.estimatedPnl >= 0 ? 'text-mint-deep' : 'text-coral-ink'}`}>
                      {fmtPnl(detail.estimatedPnl)}
                    </div>
                    <div className="font-body text-[10px] text-muted mt-1 space-y-0.5">
                      <div>
                        <span className="text-muted/70">realized </span>
                        <span className={detail.realizedPnl >= 0 ? 'text-mint-deep/80' : 'text-coral-ink/80'}>
                          {fmtPnl(detail.realizedPnl)}
                        </span>
                      </div>
                      {detail.openPositions.length > 0 && (
                        <div>
                          <span className="text-muted/70">unrealized </span>
                          <span className={detail.unrealizedPnl >= 0 ? 'text-mint-deep/80' : 'text-coral-ink/80'}>
                            {fmtPnl(detail.unrealizedPnl)}
                          </span>
                          <span className="text-muted/50"> ~</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="font-body text-[10px] text-muted uppercase tracking-wide mb-0.5">Win Rate</div>
                    <div className={`font-display font-semibold text-lg tabular-nums leading-none ${wrColor(detail.winRate)}`}>{detail.winRate.toFixed(1)}%</div>
                    <div className="font-body text-[10px] text-muted mt-1">{detail.wins}W / {detail.losses}L</div>
                  </div>
                  <div>
                    <div className="font-body text-[10px] text-muted uppercase tracking-wide mb-0.5">Trades</div>
                    <div className="font-display font-semibold text-lg text-ink tabular-nums leading-none">{detail.tradeCount.toLocaleString()}</div>
                    <div className="font-body text-[10px] text-muted mt-1">{detail.resolvedMarkets} resolved mkts</div>
                  </div>
                  <div>
                    <div className="font-body text-[10px] text-muted uppercase tracking-wide mb-0.5">Active</div>
                    <div className="font-body text-sm text-ink-2 leading-none">{fmtAge(detail.lastActive)}</div>
                    {detail.firstActive && detail.lastActive && detail.firstActive !== detail.lastActive && (
                      <div className="font-body text-[10px] text-muted mt-1">since {fmtDate(detail.firstActive)}</div>
                    )}
                  </div>
                </div>

                {/* Secondary stats */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 border border-line bg-bg-soft rounded-card p-4">
                  <div>
                    <div className="font-body text-[10px] text-muted uppercase tracking-wide mb-0.5">Volume (sample)</div>
                    <div className="font-body font-medium text-sm text-ink tabular-nums">{fmtVol(detail.totalVolume)}</div>
                  </div>
                  <div>
                    <div className="font-body text-[10px] text-muted uppercase tracking-wide mb-0.5">Avg Trade Size</div>
                    <div className="font-body font-medium text-sm text-ink tabular-nums">{fmtVol(detail.avgPositionSize)}</div>
                  </div>
                  {detail.portfolioValue != null && (
                    <div>
                      <div className="font-body text-[10px] text-muted uppercase tracking-wide mb-0.5">Portfolio Value</div>
                      <div className="font-body font-medium text-sm text-ink tabular-nums">${detail.portfolioValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                    </div>
                  )}
                </div>

                {/* Open positions */}
                {detail.openPositions.length > 0 && (
                  <div className="border border-line bg-surface rounded-card overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-line bg-bg-soft">
                      <div>
                        <span className="font-body font-medium text-[11px] uppercase tracking-wide text-muted">
                          Open Positions ({detail.openPositions.length})
                        </span>
                        <span className="ml-2 font-body text-[10px] text-gold/80">· mark-to-market · unrealized · can go to zero</span>
                      </div>
                      <span className={`font-body font-semibold text-[11px] tabular-nums ${detail.unrealizedPnl >= 0 ? 'text-mint-deep' : 'text-coral-ink'}`}>
                        {fmtPnl(detail.unrealizedPnl)} <span className="font-normal text-muted">~</span>
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[520px]">
                        <thead>
                          <tr className="border-b border-line bg-bg-soft/60">
                            <th className="px-3 py-2 text-left font-body text-[10px] text-muted font-normal">Market</th>
                            <th className="px-2 py-2 text-left font-body text-[10px] text-muted font-normal">Side</th>
                            <th className="px-2 py-2 text-right font-body text-[10px] text-muted font-normal">Tokens</th>
                            <th className="px-2 py-2 text-right font-body text-[10px] text-muted font-normal">Entry</th>
                            <th className="px-2 py-2 text-right font-body text-[10px] text-muted font-normal">Current</th>
                            <th className="px-2 py-2 text-right font-body text-[10px] text-gold/80 font-normal">Unrealized</th>
                            <th className="px-2 py-2 text-right font-body text-[10px] text-muted font-normal">Resolves</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.openPositions.map((p, i) => {
                            const pos = p.unrealizedPnl >= 0;
                            const pct = p.unrealizedPct > 0 ? '+' + p.unrealizedPct.toFixed(1) : p.unrealizedPct.toFixed(1);
                            return (
                              <tr key={i} className="border-b border-line/50 hover:bg-bg-soft/40">
                                <td className="px-3 py-1.5 font-body text-[11px] text-ink-2 max-w-[160px] truncate" title={p.title}>
                                  {p.title}
                                </td>
                                <td className="px-2 py-1.5">
                                  <span className={`font-body text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${p.outcome === 'Up' || p.outcome === 'Yes' ? 'bg-mint-tint text-mint-deep' : 'bg-coral-tint text-coral-ink'}`}>
                                    {p.outcome}
                                  </span>
                                </td>
                                <td className="px-2 py-1.5 font-body text-[11px] text-muted tabular-nums text-right">{p.size.toFixed(1)}</td>
                                <td className="px-2 py-1.5 font-body text-[11px] text-muted tabular-nums text-right">${p.avgPrice.toFixed(3)}</td>
                                <td className="px-2 py-1.5 font-body text-[11px] text-ink-2 tabular-nums text-right font-medium">${p.curPrice.toFixed(3)}</td>
                                <td className="px-2 py-1.5 tabular-nums text-right">
                                  <span className={`font-body text-[11px] font-semibold ${pos ? 'text-mint-deep' : 'text-coral-ink'}`}>
                                    {fmtPnl(p.unrealizedPnl)}
                                  </span>
                                  <div className={`font-body text-[9px] ${pos ? 'text-mint-deep/70' : 'text-coral-ink/70'}`}>{pct}%</div>
                                </td>
                                <td className="px-2 py-1.5 font-body text-[10px] text-muted text-right whitespace-nowrap">
                                  {fmtEndDate(p.endDate)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="px-4 py-2 border-t border-line/50 flex items-center gap-2">
                      <AlertCircle className="w-3 h-3 text-gold/60 shrink-0"/>
                      <span className="font-body text-[10px] text-muted">
                        Prices are live mark-to-market. Unresolved positions can settle at 0 or 1 — unrealized P&amp;L is variable until resolution.
                      </span>
                    </div>
                  </div>
                )}

                {/* Realized P&L chart */}
                <div className="border border-line bg-surface rounded-card p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-body font-medium text-[11px] uppercase tracking-wide text-muted">
                      Realized P&amp;L · {detail.resolvedMarkets} closed positions
                    </span>
                    <span className={`font-body font-semibold text-[11px] ${detail.realizedPnl >= 0 ? 'text-mint-deep' : 'text-coral-ink'}`}>
                      {fmtPnl(detail.realizedPnl)}
                    </span>
                  </div>
                  <PnlChart history={detail.pnlHistory}/>
                  {detail.pnlHistory.length >= 2 && (
                    <div className="flex justify-between font-body text-[10px] text-muted mt-1">
                      <span>{detail.pnlHistory[0]?.date}</span>
                      <span>{detail.pnlHistory[detail.pnlHistory.length - 1]?.date}</span>
                    </div>
                  )}
                </div>

                {/* Category breakdown */}
                {detail.categoryBreakdown.length > 0 && (
                  <div className="border border-line bg-surface rounded-card p-4">
                    <div className="font-body font-medium text-[11px] uppercase tracking-wide text-muted mb-3">
                      Category Breakdown · {detail.tradeCount} trades
                    </div>
                    <div className="space-y-2">
                      {detail.categoryBreakdown.map(c => (
                        <div key={c.category} className="flex items-center gap-2">
                          <span className="font-body text-[11px] text-muted w-20 shrink-0">{c.category}</span>
                          <div className="flex-1 h-2 bg-bg-soft rounded-full overflow-hidden">
                            <div
                              className={`h-full ${CAT_BAR_COLOR[c.category] ?? 'bg-muted/30'} rounded-full`}
                              style={{ width: `${c.pct}%` }}
                            />
                          </div>
                          <span className="font-body text-[11px] text-ink-2 w-8 text-right tabular-nums">{c.pct}%</span>
                          <span className="font-body text-[10px] text-muted tabular-nums w-10 text-right">({c.count})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Recent trades */}
                {detail.recentTrades.length > 0 && (
                  <div className="border border-line bg-surface rounded-card overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-line bg-bg-soft">
                      <span className="font-body font-medium text-[11px] uppercase tracking-wide text-muted">
                        Recent Trades (last {detail.recentTrades.length})
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[500px]">
                        <thead>
                          <tr className="border-b border-line bg-bg-soft/60">
                            <th className="px-3 py-2 text-left font-body text-[10px] text-muted font-normal">Market</th>
                            <th className="px-2 py-2 text-left font-body text-[10px] text-muted font-normal">Side</th>
                            <th className="px-2 py-2 text-left font-body text-[10px] text-muted font-normal">Outcome</th>
                            <th className="px-2 py-2 text-right font-body text-[10px] text-muted font-normal">Size</th>
                            <th className="px-2 py-2 text-right font-body text-[10px] text-muted font-normal">Price</th>
                            <th className="px-2 py-2 text-right font-body text-[10px] text-muted font-normal">Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.recentTrades.map((t, i) => {
                            const isBuy = t.side === 'BUY';
                            return (
                              <tr key={i} className="border-b border-line/50 hover:bg-bg-soft/40">
                                <td className="px-3 py-1.5 font-body text-[11px] text-ink-2 max-w-[180px] truncate" title={t.title}>
                                  {t.title}
                                </td>
                                <td className="px-2 py-1.5">
                                  <span className={`font-body text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${isBuy ? 'bg-mint-tint text-mint-deep' : 'bg-coral-tint text-coral-ink'}`}>
                                    {t.side}
                                  </span>
                                </td>
                                <td className="px-2 py-1.5 font-body text-[11px] text-muted">{t.outcome}</td>
                                <td className="px-2 py-1.5 font-body text-[11px] text-ink-2 tabular-nums text-right">${t.size.toFixed(0)}</td>
                                <td className="px-2 py-1.5 font-body text-[11px] text-muted tabular-nums text-right">{t.price.toFixed(3)}</td>
                                <td className="px-2 py-1.5 font-body text-[10px] text-muted text-right whitespace-nowrap">{fmtAge(t.timestamp)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Disclaimer */}
                <div className="flex items-start gap-2 p-3 border border-line bg-bg-soft rounded-card">
                  <AlertCircle className="w-3 h-3 text-muted shrink-0 mt-0.5"/>
                  <p className="font-body text-[10px] text-muted leading-relaxed">
                    <strong className="text-ink-2">Realized P&amp;L</strong> is final (settled markets).{' '}
                    <strong className="text-ink-2">Unrealized P&amp;L</strong> is mark-to-market and variable — open positions can still resolve to zero.{' '}
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

// ── Browse row (leaderboard table) ────────────────────────────────────────────

function BrowseRow({ e, rank, cat, isFollowed, onFollow, pending, onDetail }: {
  e: LbEntry; rank: number; cat: string;
  isFollowed: boolean; onFollow: () => void; pending: boolean;
  onDetail: () => void;
}) {
  const pos = e.pnlUsdc >= 0;
  return (
    <tr
      className="border-b border-line hover:bg-bg-soft/40 transition-colors duration-75 group cursor-pointer"
      onClick={onDetail}
    >
      <td className="px-3 py-2.5 font-body text-[11px] text-muted tabular-nums w-8 shrink-0">
        {rank <= 3 ? ['🥇','🥈','🥉'][rank-1] : rank}
      </td>
      <td className="px-3 py-2.5 min-w-0 max-w-[180px]">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          <span className="font-body font-medium text-sm text-ink truncate">{displayName(e)}</span>
          {e.walletType && <WalletTypeBadge type={e.walletType} />}
        </div>
        {e.name && !e.name.startsWith('0x') && (
          <div className="font-body text-[10px] text-muted truncate mt-0.5">{fmtWallet(e.wallet)}</div>
        )}
      </td>
      <td className="px-3 py-2.5 tabular-nums text-right pr-4">
        <span className={`font-display font-bold text-base ${pos ? 'text-mint-deep' : 'text-coral-ink'}`}>
          {fmtPnl(e.pnlUsdc)}
        </span>
      </td>
      <td className="px-3 py-2.5 hidden sm:table-cell">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`font-body font-medium text-sm ${wrColor(e.winRate)}`}>{e.winRate.toFixed(1)}%</span>
          {e.lowSample && <LowSampleBadge />}
        </div>
        <div className="font-body text-[10px] text-muted mt-0.5">{e.wins}W/{e.losses}L</div>
      </td>
      <td className="px-3 py-2.5 hidden md:table-cell">
        <span className="font-body text-sm text-ink-2 tabular-nums">{e.resolvedMarkets}</span>
        <div className="font-body text-[10px] text-muted">resolved</div>
      </td>
      <td className="px-3 py-2.5 hidden lg:table-cell">
        <span className="font-body text-sm text-ink-2 tabular-nums">{fmtVol(e.volumeUsdc)}</span>
        <div className="font-body text-[10px] text-muted">vol</div>
      </td>
      <td className="px-3 py-2.5 hidden xl:table-cell">
        <span className="font-body text-[11px] text-muted">{fmtAge(e.lastActive)}</span>
      </td>
      <td className="px-3 py-2" onClick={ev => ev.stopPropagation()}>
        <button onClick={onFollow} disabled={pending}
          className={[
            'flex items-center gap-1 px-2.5 py-1 rounded-button border font-body text-[10px] font-medium transition-colors whitespace-nowrap',
            isFollowed
              ? 'border-violet/50 text-violet bg-violet-tint hover:border-coral-ink/40 hover:text-coral-ink hover:bg-coral-tint'
              : 'border-line text-muted hover:border-violet/40 hover:text-violet hover:bg-violet-tint',
            pending ? 'opacity-40 cursor-not-allowed' : '',
          ].join(' ')}>
          {pending ? '…'
            : isFollowed ? <><UserMinus className="w-2.5 h-2.5"/>Watch</>
                         : <><UserPlus  className="w-2.5 h-2.5"/>Watch</>}
        </button>
      </td>
      <td className="px-2 py-2">
        <ChevronRight className="w-3.5 h-3.5 text-muted/30 group-hover:text-muted transition-colors"/>
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
      className="border-b border-line px-4 py-3 hover:bg-bg-soft/40 cursor-pointer"
      onClick={onDetail}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-body text-[11px] text-muted w-5 shrink-0">
            {rank <= 3 ? ['🥇','🥈','🥉'][rank-1] : rank}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-body font-medium text-sm text-ink truncate">{displayName(e)}</span>
              {e.walletType && <WalletTypeBadge type={e.walletType} />}
            </div>
            <div className="font-body text-[10px] text-muted">{fmtWallet(e.wallet)}</div>
          </div>
        </div>
        <span className={`font-display font-bold text-base tabular-nums shrink-0 ${pos ? 'text-mint-deep' : 'text-coral-ink'}`}>
          {fmtPnl(e.pnlUsdc)}
        </span>
      </div>
      <div className="flex gap-2 mt-1.5 ml-7 flex-wrap items-center">
        <span className={`font-body text-[11px] ${wrColor(e.winRate)}`}>{e.winRate.toFixed(1)}% WR</span>
        {e.lowSample && <LowSampleBadge />}
        <span className="font-body text-[11px] text-muted">{e.resolvedMarkets} resolved</span>
        <span className="font-body text-[11px] text-muted">{fmtVol(e.volumeUsdc)}</span>
        <span className="font-body text-[11px] text-muted">{fmtAge(e.lastActive)}</span>
        <button onClick={ev => { ev.stopPropagation(); onFollow(); }} disabled={pending}
          className={[
            'ml-auto flex items-center gap-1 px-2.5 py-1 rounded-button border font-body text-[10px] font-medium transition-colors',
            isFollowed
              ? 'border-violet/50 text-violet bg-violet-tint'
              : 'border-line text-muted hover:border-violet/40 hover:text-violet hover:bg-violet-tint',
          ].join(' ')}>
          {pending ? '…' : isFollowed
            ? <><UserMinus className="w-2.5 h-2.5"/>Watch</>
            : <><UserPlus  className="w-2.5 h-2.5"/>Watch</>}
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
  const catColor = CAT_COLOR[f.category] ?? 'text-muted';
  return (
    <tr
      className="border-b border-line hover:bg-bg-soft/40 transition-colors duration-75 cursor-pointer"
      onClick={onDetail}
    >
      <td className="px-3 py-2.5 min-w-0">
        <div className="font-body font-medium text-sm text-ink">{displayName(f)}</div>
        <div className="font-body text-[10px] text-muted">{fmtWallet(f.wallet)}</div>
      </td>
      <td className="px-3 py-2.5 hidden sm:table-cell">
        <span className={`font-body text-[11px] font-medium uppercase tracking-wide ${catColor}`}>{f.category}</span>
      </td>
      <td className="px-3 py-2.5 tabular-nums text-right pr-4">
        <span className={`font-display font-semibold text-base ${f.pnlUsdc != null ? (pos ? 'text-mint-deep' : 'text-coral-ink') : 'text-muted'}`}>
          {fmtPnl(f.pnlUsdc)}
        </span>
        {f.winRate != null && (
          <div className={`font-body text-[10px] mt-0.5 ${wrColor(f.winRate)}`}>{f.winRate.toFixed(0)}% WR</div>
        )}
      </td>
      <td className="px-3 py-2.5 hidden md:table-cell">
        <span className="font-body text-sm text-ink-2">{fmtVol(f.volumeUsdc)}</span>
      </td>
      <td className="px-3 py-2.5 hidden lg:table-cell">
        <span className="font-body text-[11px] text-muted">{fmtAge(f.lastActive)}</span>
      </td>
      <td className="px-3 py-2" onClick={ev => ev.stopPropagation()}>
        <button onClick={onToggle} disabled={pending}
          title={f.alertsEnabled ? 'Alerts on — click to mute' : 'Alerts off'}
          className={[
            'flex items-center gap-1 px-2.5 py-1 rounded-button border font-body text-[10px] font-medium transition-colors whitespace-nowrap',
            f.alertsEnabled
              ? 'border-violet/40 text-violet bg-violet-tint'
              : 'border-line text-muted',
          ].join(' ')}>
          {f.alertsEnabled ? <><Bell className="w-2.5 h-2.5"/>ON</> : <><BellOff className="w-2.5 h-2.5"/>OFF</>}
        </button>
      </td>
      <td className="px-3 py-2" onClick={ev => ev.stopPropagation()}>
        <button onClick={onUnfollow} disabled={pending}
          className="flex items-center gap-1 px-2.5 py-1 rounded-button border border-line font-body text-[10px] text-muted hover:border-coral-ink/40 hover:text-coral-ink transition-colors">
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
  const catColor = CAT_COLOR[f.category] ?? 'text-muted';
  return (
    <div
      className="border-b border-line px-4 py-3 hover:bg-bg-soft/40 cursor-pointer"
      onClick={onDetail}
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-body font-medium text-sm text-ink">{displayName(f)}</div>
          <div className="font-body text-[10px] text-muted">{fmtWallet(f.wallet)}</div>
        </div>
        <span className={`font-display font-bold text-base tabular-nums ${f.pnlUsdc != null ? (pos ? 'text-mint-deep' : 'text-coral-ink') : 'text-muted'}`}>
          {fmtPnl(f.pnlUsdc)}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        <span className={`font-body text-[11px] font-medium uppercase ${catColor}`}>{f.category}</span>
        {f.winRate != null && <span className={`font-body text-[11px] ${wrColor(f.winRate)}`}>{f.winRate.toFixed(0)}% WR</span>}
        <span className="font-body text-[11px] text-muted">{fmtVol(f.volumeUsdc)}</span>
        <span className="font-body text-[11px] text-muted">{fmtAge(f.lastActive)}</span>
        <button onClick={ev => { ev.stopPropagation(); onToggle(); }} disabled={pending}
          className={[
            'ml-auto flex items-center gap-1 px-2.5 py-1 rounded-button border font-body text-[10px] font-medium',
            f.alertsEnabled ? 'border-violet/40 text-violet bg-violet-tint' : 'border-line text-muted',
          ].join(' ')}>
          {f.alertsEnabled ? <><Bell className="w-2.5 h-2.5"/>ON</> : <><BellOff className="w-2.5 h-2.5"/>OFF</>}
        </button>
        <button onClick={ev => { ev.stopPropagation(); onUnfollow(); }} disabled={pending}
          className="flex items-center gap-1 px-2.5 py-1 rounded-button border border-line font-body text-[10px] text-muted hover:text-coral-ink transition-colors">
          <UserMinus className="w-2.5 h-2.5"/>Remove
        </button>
      </div>
    </div>
  );
}

// ── Alert feed row ────────────────────────────────────────────────────────────

function AlertRow({ a }: { a: TradeAlert }) {
  const isBuy = (a.side ?? '').toUpperCase() === 'BUY';
  const catColor = CAT_COLOR[a.category] ?? 'text-muted';
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 border-b border-line hover:bg-bg-soft/40">
      <div className="shrink-0 w-12 font-body text-[10px] text-muted tabular-nums pt-0.5">{fmtAge(a.alertSentAt)}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-body font-medium text-sm text-ink">{a.name || fmtWallet(a.wallet)}</span>
          <span className={`font-body text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${isBuy ? 'bg-mint-tint text-mint-deep' : 'bg-coral-tint text-coral-ink'}`}>
            {(a.side ?? '').toUpperCase()} {a.outcome}
          </span>
          <span className="font-body text-[11px] text-muted">@ ${(a.price ?? 0).toFixed(3)}</span>
          <span className="font-body font-semibold text-[11px] text-ink-2">${(a.size ?? 0).toFixed(0)}</span>
        </div>
        <div className="font-body text-[10px] text-muted truncate mt-0.5 max-w-[380px]">{a.market}</div>
      </div>
      <span className={`shrink-0 font-body text-[10px] font-medium uppercase ${catColor}`}>{a.category}</span>
    </div>
  );
}

// ── Add wallet inline form ────────────────────────────────────────────────────

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
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-button border border-violet/40 text-violet bg-violet-tint font-body text-[10px] font-medium uppercase tracking-wide hover:border-violet hover:bg-violet-tint transition-colors shrink-0">
      <UserPlus className="w-3 h-3"/>Watch wallet
    </button>
  );

  return (
    <form onSubmit={submit} className="flex items-center gap-2 flex-wrap">
      <input type="text" value={addr} onChange={e => setAddr(e.target.value)}
        placeholder="0x wallet address" autoFocus
        className="font-body text-sm bg-surface border border-line rounded-button px-3 py-1.5 text-ink placeholder:text-muted focus:outline-none focus:border-violet/50 w-48"/>
      <input type="text" value={label} onChange={e => setLabel(e.target.value)}
        placeholder="label (optional)"
        className="font-body text-sm bg-surface border border-line rounded-button px-3 py-1.5 text-ink placeholder:text-muted focus:outline-none focus:border-violet/50 w-28"/>
      <button type="submit" disabled={loading}
        className="px-3 py-1.5 rounded-button bg-violet text-white font-body text-[10px] font-medium uppercase tracking-wide hover:opacity-90 transition-opacity disabled:opacity-50">
        {loading ? '…' : 'Watch'}
      </button>
      <button type="button" onClick={() => { setOpen(false); setErr(''); }}
        className="px-3 py-1.5 rounded-button border border-line font-body text-[10px] text-muted hover:text-ink transition-colors">
        Cancel
      </button>
      {err && <span className="font-body text-[10px] text-coral-ink">{err}</span>}
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
    <div className="mt-6 rounded-panel border border-line bg-surface overflow-hidden shadow-card">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-line bg-bg-soft">
        <div className="flex items-center gap-2">
          <Lock className="w-3.5 h-3.5 text-muted"/>
          <span className="font-body font-semibold text-sm text-ink-2">Auto-Copy Execution</span>
        </div>
        <span className="font-body text-[10px] font-medium px-2.5 py-1 rounded-pill border border-line text-muted uppercase tracking-wide bg-bg-soft">LOCKED</span>
      </div>
      <div className="p-5">
        <div className="flex items-center gap-3 mb-5 pb-4 border-b border-line">
          <div className="w-10 h-5 rounded-full bg-line flex items-center px-0.5 cursor-not-allowed select-none">
            <div className="w-4 h-4 rounded-full bg-muted/40"/>
          </div>
          <span className="font-body text-sm text-muted">Enable auto-copy execution</span>
          <Lock className="w-3 h-3 text-muted/60 ml-auto"/>
        </div>
        <div className="space-y-4">
          {steps.map(({ n, label, desc, done }) => (
            <div key={n} className="flex items-start gap-3">
              <div className={`shrink-0 w-5 h-5 rounded-full border flex items-center justify-center mt-0.5 text-[10px] font-body font-medium
                ${done ? 'border-mint-deep/60 bg-mint-tint text-mint-deep' : 'border-line text-muted'}`}>
                {done ? '✓' : <Lock className="w-2.5 h-2.5"/>}
              </div>
              <div>
                <div className={`font-body font-medium text-sm ${done ? 'text-ink' : 'text-muted'}`}>
                  {n}. {label}{done && <span className="ml-2 font-body text-[10px] text-mint-deep font-normal">active</span>}
                </div>
                <div className="font-body text-[11px] text-muted mt-0.5">{desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 p-3 bg-bg-soft border border-line rounded-card">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-3 h-3 text-muted shrink-0 mt-0.5"/>
            <p className="font-body text-[10px] text-muted leading-relaxed">
              <strong className="text-ink-2">No keys collected — ever.</strong> Not now, not at any step.
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

  const [detailOpen,    setDetailOpen]    = useState(false);
  const [detailWallet,  setDetailWallet]  = useState('');
  const [detailData,    setDetailData]    = useState<WalletDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError,   setDetailError]   = useState('');

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

  const followedSet   = new Set((copyData?.wallets ?? []).map(w => w.wallet));
  const followedCount = copyData?.wallets?.length ?? 0;

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

  function handleSearchKey(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key === 'Enter' && isWalletAddress(search)) {
      openDetail(search.trim());
    }
  }

  const isSearchAddr = isWalletAddress(search);

  const allTraders = typeFilter === 'MM'
    ? (lbData?.mmCategories?.[cat] ?? [])
    : (lbData?.categories?.[cat]   ?? []);
  const traders = isSearchAddr ? [] : allTraders.filter(e => {
    if (!matchesSearch(e, search)) return false;
    if (typeFilter === 'DIRECTIONAL') return e.walletType === 'DIRECTIONAL';
    return true;
  });
  const warmingUp = !lbData || (!lbData.ok && !lbData.updatedAt);

  const followed        = copyData?.wallets ?? [];
  const filteredFollowed = followed.filter(f => matchesSearch(f, search));
  const alerts          = copyData?.recentAlerts ?? [];

  return (
    <div className="max-w-[1100px] mx-auto px-4 py-8">

      {/* Wallet detail panel */}
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

      {/* ── Page header ───────────────────────────────────────────────────────── */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Eyebrow className="inline-flex items-center gap-1.5"><PlatformLogo platform="polymarket" size={12} />Polymarket · Leaderboard</Eyebrow>
          <SectionHeading as="h1" className="text-3xl mt-1">Traders</SectionHeading>
          <p className="font-body text-sm text-muted mt-1.5">
            Realized P&amp;L · {lbData?.windowDays ?? 730}d window ·{' '}
            {lbData?.totalWallets ?? 0} wallets ranked · {lbData?.marketsScanned ?? 0} markets scanned
          </p>
          {/* Signal framing note */}
          <div className="flex items-center gap-2 mt-2">
            <EdgeChip variant="signal" />
            <span className="font-body text-[11px] text-muted">
              Observational intelligence — not a copy-trade signal. Following grants no edge guarantee.
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 font-body text-[11px]">
          {lbData?.stale && (
            <span className="text-gold">data {lbData.staleMinutes}m old · refreshing</span>
          )}
          <span className={copyData?.online ? 'text-mint-deep' : 'text-muted'}>
            alert agent {copyData?.online ? 'online' : 'starting…'}
          </span>
          {lbData?.updatedAt && !lbData.stale && (
            <span className="text-muted">
              updated {new Date(lbData.updatedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {/* ── Search ────────────────────────────────────────────────────────────── */}
      <div className="relative mb-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted pointer-events-none"/>
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={handleSearchKey}
          placeholder="Search by trader name or wallet address — paste 0x… and press Enter to look up"
          className="w-full font-body text-sm bg-surface border border-line rounded-button pl-9 pr-9 py-2 text-ink placeholder:text-muted focus:outline-none focus:border-violet/40 transition-colors"
        />
        {search && (
          <button onClick={() => { setSearch(''); searchRef.current?.focus(); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-ink">
            <X className="w-3.5 h-3.5"/>
          </button>
        )}
      </div>

      {/* Address lookup hint */}
      {isSearchAddr ? (
        <div className="mb-3 flex items-center gap-2">
          <button
            onClick={() => openDetail(search.trim())}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-button border border-violet/50 text-violet bg-violet-tint font-body text-[10px] font-medium uppercase tracking-wide hover:border-violet transition-colors"
          >
            <Search className="w-3 h-3"/>Look up {fmtWallet(search.trim())} on <PlatformLogo platform="polymarket" size={11} className="mx-1" />Polymarket ↗
          </button>
          <span className="font-body text-[10px] text-muted">or press Enter</span>
        </div>
      ) : (
        <div className="mb-3"/>
      )}

      {/* ── Main tabs ─────────────────────────────────────────────────────────── */}
      <div className="flex gap-0 border-b border-line mb-4">
        {(['browse', 'following'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={[
              'px-4 py-2 font-body font-medium text-[11px] uppercase tracking-widest transition-colors duration-100 relative',
              tab === t ? 'text-mint-deep' : 'text-muted hover:text-ink-2',
            ].join(' ')}>
            {t === 'browse' ? `Browse (${allTraders.length})` : `Following (${followedCount})`}
            {tab === t && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-mint-deep rounded-full"/>}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 border border-coral-ink/30 bg-coral-tint rounded-card font-body text-[11px] text-coral-ink">
          {error}
        </div>
      )}

      {/* ═════════════════════════ BROWSE TAB ════════════════════════ */}
      {tab === 'browse' && (
        <>
          {/* Category tabs */}
          <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1 scrollbar-none">
            {CATEGORIES.map(c => {
              const count  = lbData?.categories?.[c]?.length ?? 0;
              const active = c === cat;
              return (
                <button key={c} onClick={() => setCat(c)}
                  className={[
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-button border font-body font-medium text-[11px] uppercase tracking-wide whitespace-nowrap transition-colors shrink-0',
                    active
                      ? 'border-mint-deep/40 bg-mint-tint text-mint-deep'
                      : 'border-line text-muted hover:border-mint-deep/30 hover:text-ink-2 bg-surface',
                  ].join(' ')}>
                  <span>{CAT_META[c].emoji}</span>
                  <span>{c}</span>
                  {count > 0 && (
                    <span className={`font-body text-[9px] px-1.5 py-0.5 rounded-pill ${active ? 'bg-mint-deep/20 text-mint-deep' : 'bg-line text-muted'}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Type filter */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {(['all', 'DIRECTIONAL', 'MM'] as const).map(f => {
              const labels = { all: 'All Types', DIRECTIONAL: 'Directional', MM: 'MM / Neutral' } as const;
              const active = typeFilter === f;
              return (
                <button key={f} onClick={() => setTypeFilter(f)}
                  className={[
                    'px-2.5 py-1 rounded-button border font-body font-medium text-[10px] uppercase tracking-wide transition-colors',
                    active
                      ? f === 'MM'
                        ? 'border-gold/50 text-gold bg-gold-tint'
                        : f === 'DIRECTIONAL'
                          ? 'border-violet/50 text-violet bg-violet-tint'
                          : 'border-line text-ink bg-bg-soft'
                      : 'border-line text-muted hover:border-line hover:text-ink-2 bg-surface',
                  ].join(' ')}>
                  {labels[f]}
                </button>
              );
            })}
            {typeFilter === 'DIRECTIONAL' && (
              <span className="font-body text-[10px] text-muted">directional = copy-watchable · MM = observe only</span>
            )}
            {typeFilter === 'MM' && (
              <span className="font-body text-[10px] text-gold">trades both sides — not a directional signal</span>
            )}
          </div>

          {/* Description line */}
          <p className="font-body text-[11px] text-muted mb-3">
            {CAT_META[cat].desc} · min {lbData?.minMarketsToRank ?? 20} resolved markets to rank
            {typeFilter === 'MM'
              ? ' · MM wallets sorted by two-sided market count (spread activity)'
              : ' · sorted by Wilson 95% confidence lower bound on win rate'}
            {search && !isSearchAddr && ` · ${traders.length} matching "${search}"`}
            {isSearchAddr && ' · paste complete address above then press Enter to look up'}
          </p>

          {/* Warming up */}
          {warmingUp && (
            <div className="rounded-card border border-line bg-surface shadow-card p-8 text-center">
              <div className="font-body font-medium text-sm text-ink-2 mb-1">Agent warming up — scanning resolved markets…</div>
              <div className="font-body text-[11px] text-muted">First data in ~2–3 min. Rankings deepen over time.</div>
            </div>
          )}

          {/* No results */}
          {!warmingUp && !isSearchAddr && traders.length === 0 && (
            <div className="rounded-card border border-line bg-surface shadow-card p-8 text-center">
              <div className="font-body font-medium text-sm text-ink-2 mb-1">
                {search ? `No traders matching "${search}" in ${cat}` : `No traders ranked in ${cat} yet`}
              </div>
              {search && (
                <button onClick={() => setSearch('')}
                  className="mt-2 font-body text-[11px] text-violet hover:underline">Clear search</button>
              )}
            </div>
          )}

          {/* Desktop table */}
          {!warmingUp && !isSearchAddr && traders.length > 0 && (
            <>
              <div className="hidden sm:block rounded-card border border-line bg-surface shadow-card overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-line bg-bg-soft">
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-muted w-8">#</th>
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-muted">Trader</th>
                      <th className="px-3 py-2.5 text-right font-body font-medium text-[10px] uppercase tracking-widest text-muted pr-4">P&amp;L</th>
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-mint-deep hidden sm:table-cell">
                        Wilson 95% CI ↓
                      </th>
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-muted hidden md:table-cell">Resolved</th>
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-muted hidden lg:table-cell">Volume</th>
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-muted hidden xl:table-cell">Active</th>
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-muted">Watch</th>
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
              <div className="sm:hidden rounded-card border border-line bg-surface shadow-card overflow-hidden">
                <div className="border-b border-line px-4 py-2.5 flex justify-between bg-bg-soft">
                  <span className="font-body font-medium text-[10px] text-muted uppercase tracking-widest">Trader</span>
                  <span className="font-body font-medium text-[10px] text-mint-deep uppercase tracking-widest">P&amp;L ↓</span>
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
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard
                label="Markets Scanned"
                value={String(lbData?.marketsScanned ?? 0)}
                note="Polymarket resolved"
              />
              <StatCard
                label="Wallets Ranked"
                value={String(lbData?.totalWallets ?? 0)}
                note={`min ${lbData?.minMarketsToRank ?? 5} resolved mkts`}
              />
              <StatCard
                label="Window"
                value={`${lbData?.windowDays ?? 730}d`}
                note="rolling lookback"
              />
              <StatCard
                label="Rank Method"
                value="Wilson"
                note="95% CI lower bound on win rate"
              />
            </div>
          )}
        </>
      )}

      {/* ═════════════════════════ FOLLOWING TAB ════════════════════════ */}
      {tab === 'following' && (
        <>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <p className="font-body text-[11px] text-muted">
              {followedCount}/{copyData?.maxWallets ?? 50} slots used · alerts via Telegram + shown below
            </p>
            <AddWalletForm onAdd={addWallet}/>
          </div>

          {followed.length === 0 ? (
            <div className="rounded-card border border-line bg-surface shadow-card p-8 text-center">
              <div className="font-body font-semibold text-sm text-ink mb-2">No traders watched yet</div>
              <div className="font-body text-[11px] text-muted mb-4">
                Switch to Browse to watch traders from the leaderboard, or paste a wallet address above.
              </div>
              <button onClick={() => setTab('browse')}
                className="px-4 py-2 rounded-button border border-violet/40 text-violet bg-violet-tint font-body font-medium text-[11px] uppercase tracking-wide hover:border-violet transition-colors">
                Browse Leaderboard
              </button>
            </div>
          ) : (
            <>
              {/* Desktop */}
              <div className="hidden sm:block rounded-card border border-line bg-surface shadow-card overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-line bg-bg-soft">
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-muted">Trader</th>
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-muted hidden sm:table-cell">Category</th>
                      <th className="px-3 py-2.5 text-right font-body font-medium text-[10px] uppercase tracking-widest text-mint-deep pr-4">P&amp;L</th>
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-muted hidden md:table-cell">Volume</th>
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-muted hidden lg:table-cell">Active</th>
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-muted">Alerts</th>
                      <th className="px-3 py-2.5 text-left font-body font-medium text-[10px] uppercase tracking-widest text-muted">Action</th>
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
              <div className="sm:hidden rounded-card border border-line bg-surface shadow-card overflow-hidden">
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
                <div className="rounded-card border border-line bg-surface shadow-card p-6 text-center font-body text-sm text-muted">
                  No followed traders matching &quot;{search}&quot;
                </div>
              )}
            </>
          )}

          {/* Alerts feed */}
          <div className="mt-5 rounded-card border border-line bg-surface shadow-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-bg-soft">
              <span className="font-body font-semibold text-sm text-ink-2">
                Recent Trade Alerts{alerts.length > 0 && ` (${alerts.length})`}
              </span>
              <span className="font-body text-[11px] text-muted">Telegram + shown here</span>
            </div>
            {alerts.length === 0 ? (
              <div className="px-4 py-8 text-center font-body text-sm text-muted">
                {followed.length === 0
                  ? 'Watch a trader to receive alerts'
                  : 'No alerts yet — fires when watched traders make new Polymarket trades'}
              </div>
            ) : (
              alerts.slice(0, 40).map((a, i) => <AlertRow key={i} a={a}/>)
            )}
          </div>
        </>
      )}

      {/* ── Locked panel ─────────────────────────────────────────────────────── */}
      <LockedPanel/>

      {/* Footer */}
      <p className="mt-6 font-body text-[11px] text-muted border-t border-line pt-4 leading-relaxed">
        Leaderboard from on-chain resolved Polymarket markets. Rankings use Wilson 95% confidence lower bound on win rate — raw win rate alone can mislead on small samples.
        Wallets with fewer than the minimum resolved markets are flagged <span className="text-gold font-medium">low sample</span> and excluded from top-rank positions.
        P&amp;L estimated from trade data — may differ from actual balances (partial fills, gas, open positions).
        Wallet addresses are public identifiers; watching grants no access.
        Alerts reflect observed trades; manual copy has slippage + timing risk. Past performance ≠ future results. Not financial advice.
      </p>

    </div>
  );
}
