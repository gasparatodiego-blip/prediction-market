'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, AlertCircle, Cpu, User, Activity, ChevronRight } from 'lucide-react';
import { Redacted, RedactedPanel } from '@/app/components/ui/Redacted';
import { polymarketProfileUrl } from '@/lib/platform-links';
import { ActorBadge, VerifiedTick, WinRate, CopyButton } from './parts';
import {
  fmtPnl, fmtVol, fmtPrice, fmtSize, fmtAge, displayName,
  pnlColor, catBar, catText,
  type LbEntry, type TraderProfile as Profile, type WindowKey, type ClosedTrade,
} from './format';

// ¢ price for the fill drawer (matches the prompt's "price (¢)"; null → redacted "—").
function fmtCents(p: number | null | undefined): string {
  if (p == null) return '—';
  return (p * 100).toFixed(1) + '¢';
}
// Real time-to-expiry at a fill: how long before the market closed the trader acted.
// null secToExpiry → the close couldn't be sourced → honest "expiry unavailable"
// (never a fabricated countdown). Negative → the fill landed at/after close.
function fmtToExpiry(sec: number | null | undefined): string {
  if (sec == null) return 'expiry unavailable';
  if (sec < 0) return 'after close';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m >= 60) { const h = Math.floor(m / 60); return `${h}h ${m % 60}m before close`; }
  if (m > 0)   return `${m}m ${s}s before close`;
  return `${s}s before close`;
}

const WINDOW_LABEL: Record<WindowKey, string> = { '1d': '1D', '7d': '7D', '30d': '30D', all: 'All' };

// Cumulative realized-P&L line, built ONLY from visible closed trades (redacted
// → null → excluded). Never plots a null-coerced-to-zero point. Honest-engine.
function PnlSpark({ series }: { series: number[] }) {
  if (series.length < 2) return null;
  const W = 600, H = 90, PAD = 6;
  const cum: number[] = [];
  series.forEach((v, i) => cum.push((cum[i - 1] ?? 0) + v));
  const min = Math.min(0, ...cum), max = Math.max(0, ...cum), range = max - min || 1;
  const toX = (i: number) => PAD + (i / (cum.length - 1)) * (W - PAD * 2);
  const toY = (v: number) => PAD + (H - PAD * 2) - ((v - min) / range) * (H - PAD * 2);
  const line = cum.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');
  const zeroY = toY(0);
  const final = cum[cum.length - 1];
  const color = final >= 0 ? '#0c9d6e' : '#c2410c';
  const fill  = final >= 0 ? 'rgba(12,157,110,0.08)' : 'rgba(194,65,12,0.08)';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24" preserveAspectRatio="none">
      <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="rgba(14,26,22,0.08)" strokeWidth="1" />
      <polygon points={`${toX(0)},${zeroY} ${line} ${toX(cum.length - 1)},${zeroY}`} fill={fill} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.6" />
      <circle cx={toX(cum.length - 1)} cy={toY(final)} r="2.5" fill={color} />
    </svg>
  );
}

type MoveFilter = 'all' | 'open' | 'closed';

export default function TraderProfileView({
  entry, profile, loading, error, onBack,
  copying, atLimit, tier, maxSlots, onToggleCopy,
}: {
  entry:    LbEntry;
  profile:  Profile | null;
  loading:  boolean;
  error:    string;
  onBack:   () => void;
  copying:  boolean;
  atLimit:  boolean;
  tier:     'free' | 'pro';
  maxSlots: number;
  onToggleCopy: () => void;
}) {
  const [move, setMove] = useState<MoveFilter>('all');
  const [win, setWin]   = useState<WindowKey>('all');
  const [openRows, setOpenRows] = useState<Set<number>>(() => new Set());
  const toggleRow = (i: number) => setOpenRows(prev => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });

  const actor = profile?.actorType ?? entry.actorType ?? null;
  const isBot = actor?.type === 'bot';
  const walletKind = isBot || entry.walletType === 'MM' ? 'Algorithmic' : 'Directional';

  // Window selector only appears when the agent has actually backfilled per-window
  // data — otherwise the hero shows all-time resolved P&L (no fake sub-windows).
  const availWindows = useMemo<WindowKey[]>(() => {
    const w = profile?.windows;
    if (!w) return [];
    return (['1d', '7d', '30d', 'all'] as WindowKey[]).filter(k => w[k] && w[k].pnlUsdc != null);
  }, [profile]);

  const heroPnl = availWindows.length && profile?.windows
    ? profile.windows[win]?.pnlUsdc ?? entry.pnlUsdc
    : entry.pnlUsdc;
  const heroLabel = availWindows.length ? `${WINDOW_LABEL[win]} realized P&L` : 'All-time resolved P&L';

  // Cumulative series from visible (non-redacted) closed trades, oldest → newest.
  const pnlSeries = useMemo<number[]>(() => {
    const t = profile?.tradesClosed ?? [];
    return t
      .filter(x => x.realizedPnl != null)
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(x => x.realizedPnl as number);
  }, [profile]);

  const maxCatAbs = useMemo(() => {
    const c = profile?.categories ?? [];
    return Math.max(1, ...c.map(x => Math.abs(x.pnlUsdc ?? 0)));
  }, [profile]);

  return (
    <div className="space-y-5">
      {/* Back */}
      <button onClick={onBack}
        className="inline-flex items-center gap-1.5 font-body text-[11px] font-medium text-muted hover:text-ink transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" />Back to leaderboard
      </button>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-display font-bold text-2xl text-ink leading-none">{displayName(entry)}</h2>
            <VerifiedTick show={entry.verified} />
            <ActorBadge actor={actor} />
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="font-body text-[11px] text-muted break-all">{entry.wallet}</span>
            {(() => {
              const u = polymarketProfileUrl(entry.wallet);
              return u ? (
                <a href={u} target="_blank" rel="noopener noreferrer"
                  className="text-muted hover:text-[#0c9d6e] transition-colors" title="View on Polymarket">
                  <ExternalLink className="w-3 h-3" />
                </a>
              ) : null;
            })()}
          </div>
        </div>
      </div>

      {loading && (
        <div className="py-16 text-center font-body text-sm text-muted animate-pulse">Loading trader profile…</div>
      )}

      {!loading && error && (
        <div className="flex items-start gap-2 p-4 border border-line bg-bg-soft rounded-card">
          <AlertCircle className="w-3.5 h-3.5 text-muted shrink-0 mt-0.5" />
          <div className="min-w-0">
            <span className="font-body text-[11px] text-muted">{error}</span>
            {/* Honest-engine: the heavy leaderboard profile may be missing while a live
                feed exists — never hide real data behind this empty-state. The live-feed
                page renders real fills/positions, or its own honest absence notice. */}
            <div className="mt-2">
              <Link href={`/dashboard/traders/${entry.wallet.toLowerCase()}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-mint-deep/40 bg-mint-tint px-2 py-1 font-body text-[11px] font-medium text-mint-deep hover:border-mint-deep transition-colors">
                <Activity className="w-3 h-3 shrink-0" /> Open live trade feed
              </Link>
            </div>
          </div>
        </div>
      )}

      {!loading && !error && (
        <>
          {/* PnL hero + stat row */}
          <div className="rounded-panel border border-line bg-surface shadow-card p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="font-body text-[10px] uppercase tracking-widest text-muted mb-1">{heroLabel}</div>
                <div className={`font-display font-bold text-4xl tabular-nums leading-none ${pnlColor(heroPnl)}`}>
                  <Redacted value={heroPnl}>{v => fmtPnl(v)}</Redacted>
                </div>
                {/* Only windows with populated per-window data render; with a single
                    available window the selector is omitted (no dead buttons). */}
                {availWindows.length > 1 && (
                  <div className="flex gap-3 mt-3">
                    {availWindows.map(k => (
                      <button key={k} onClick={() => setWin(k)}
                        className={[
                          'font-body text-[11px] pb-0.5 border-b-2 transition-colors',
                          win === k ? 'text-ink border-[#0c9d6e]' : 'text-muted border-transparent hover:text-ink-2',
                        ].join(' ')}>
                        {WINDOW_LABEL[k]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="shrink-0">
                <CopyButton copying={copying} atLimit={atLimit} tier={tier} maxSlots={maxSlots} onToggle={onToggleCopy} size="lg" />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-4 border-t border-line">
              <Stat label="Volume">
                <Redacted value={entry.volumeUsdc}>{v => fmtVol(v)}</Redacted>
              </Stat>
              <Stat label="Win rate">
                <WinRate winRate={entry.winRate} wilson={entry.wilsonScore} resolvedMarkets={entry.resolvedMarkets} />
              </Stat>
              <Stat label="Resolved mkts">
                <span className="text-ink">{entry.resolvedMarkets.toLocaleString()}</span>
              </Stat>
              <Stat label="Type">
                <span className="inline-flex items-center gap-1 text-ink-2 text-sm">
                  {walletKind === 'Algorithmic' ? <Cpu className="w-3 h-3" /> : <User className="w-3 h-3" />}
                  {walletKind}
                </span>
              </Stat>
            </div>
          </div>

          {/* Cumulative P&L (from visible trades) */}
          {pnlSeries.length >= 2 ? (
            <div className="rounded-card border border-line bg-surface shadow-card p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="font-body font-medium text-[11px] uppercase tracking-wide text-muted">Cumulative realized P&amp;L</span>
                <span className="font-body text-[10px] text-muted">from {pnlSeries.length} visible trades</span>
              </div>
              <PnlSpark series={pnlSeries} />
            </div>
          ) : (profile?.tradesClosed?.length ?? 0) > 0 && (profile?.tradesClosed ?? []).every(t => t.realizedPnl == null) ? (
            <RedactedPanel label="Cumulative P&L chart is available on Pro" className="!py-8" />
          ) : null}

          {/* Profit by category */}
          {(profile?.categories?.length ?? 0) > 0 && (
            <div className="rounded-card border border-line bg-surface shadow-card p-4">
              <div className="font-body font-medium text-[11px] uppercase tracking-wide text-muted mb-3">Profit by category</div>
              <div className="space-y-2.5">
                {profile!.categories.map(c => {
                  const pos = (c.pnlUsdc ?? 0) >= 0;
                  const w = c.pnlUsdc != null ? (Math.abs(c.pnlUsdc) / maxCatAbs) * 100 : 0;
                  return (
                    <div key={c.category} className="flex items-center gap-3">
                      <span className={`font-body text-[11px] w-24 shrink-0 truncate ${catText(c.category)}`}>{c.category}</span>
                      <div className="flex-1 h-2.5 bg-bg-soft rounded-full overflow-hidden">
                        {c.pnlUsdc != null && (
                          <div className={`h-full rounded-full ${pos ? catBar(c.category) : 'bg-coral-ink/50'}`} style={{ width: `${Math.max(2, w)}%` }} />
                        )}
                      </div>
                      <span className={`font-body text-[11px] tabular-nums w-20 text-right ${pnlColor(c.pnlUsdc)}`}>
                        <Redacted value={c.pnlUsdc}>{v => fmtPnl(v)}</Redacted>
                      </span>
                      <span className="font-body text-[10px] text-muted tabular-nums w-14 text-right hidden sm:inline">
                        <Redacted value={c.winRate}>{v => `${v.toFixed(0)}%`}</Redacted> · {c.resolvedMarkets}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Actor block */}
          {actor && (
            <div className="rounded-card border border-line bg-bg-soft p-4">
              <div className="flex items-center gap-2 mb-2">
                {isBot ? <Cpu className="w-3.5 h-3.5 text-[#2f6fb0]" /> : <User className="w-3.5 h-3.5 text-muted" />}
                <span className="font-body font-medium text-[11px] text-ink-2">
                  Why likely {actor.type} · {actor.confidence}% confidence
                </span>
              </div>
              {actor.signals.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {actor.signals.map((s, i) => (
                    <span key={i} className="font-body text-[10px] text-muted px-2 py-1 rounded-md border border-line bg-surface">{s}</span>
                  ))}
                </div>
              ) : (
                <span className="font-body text-[10px] text-muted">Thin trade history — classified human by default.</span>
              )}
              <p className="font-body text-[10px] text-muted mt-2 leading-relaxed">
                Heuristic inference from observable trade timing/frequency — not a Polymarket label.
              </p>
            </div>
          )}

          {/* Movements */}
          <div className="rounded-card border border-line bg-surface shadow-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-bg-soft flex-wrap gap-2">
              <span className="font-body font-semibold text-sm text-ink-2">Movements</span>
              <div className="flex gap-3">
                {(['all', 'open', 'closed'] as MoveFilter[]).map(f => (
                  <button key={f} onClick={() => setMove(f)}
                    className={[
                      'font-body text-[11px] uppercase tracking-wide pb-0.5 border-b-2 transition-colors',
                      move === f ? 'text-ink border-[#0c9d6e]' : 'text-muted border-transparent hover:text-ink-2',
                    ].join(' ')}>
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {/* Open positions */}
            {(move === 'all' || move === 'open') && (
              <MoveSection title={`Open positions (${profile?.positionsOpen?.length ?? 0})`} note="unrealized · mark-to-market · can resolve to zero">
                {(profile?.positionsOpen?.length ?? 0) === 0 ? (
                  <Empty>No open positions.</Empty>
                ) : (
                  <Table stickyFirst cols={['Market', 'Outcome', 'Size', 'Entry', 'Value', 'Unrealized']}>
                    {profile!.positionsOpen.map((p, i) => (
                      <tr key={i} className="border-b border-line/50 hover:bg-bg-soft/40">
                        <Cell sticky title={p.marketTitle}>{p.marketTitle ?? '—'}</Cell>
                        <OutcomeCell outcome={p.outcome} />
                        <NumCell>{fmtSize(p.size)}</NumCell>
                        <NumCell>$<Redacted value={p.avgPrice}>{v => fmtPrice(v)}</Redacted></NumCell>
                        <NumCell>$<Redacted value={p.currentValue}>{v => fmtSize(v)}</Redacted></NumCell>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          <span className={`font-body text-[11px] font-semibold ${pnlColor(p.unrealizedPnl)}`}>
                            <Redacted value={p.unrealizedPnl}>{v => fmtPnl(v)}</Redacted>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </MoveSection>
            )}

            {/* Closed trades */}
            {(move === 'all' || move === 'closed') && (
              <MoveSection title={`Closed trades (${profile?.tradesClosed?.length ?? 0})`} note={`realized · gross · newest first${
                (profile?.entryExitSource === 'ondemand' || profile?.entryExitSource === 'feed+ondemand') && profile?.entryExitAsOf
                  ? ` · entry→exit reconstructed on-demand, as of ${new Date(profile.entryExitAsOf).toLocaleTimeString()}`
                  : ''
              }`}>
                {(profile?.tradesClosed?.length ?? 0) === 0 ? (
                  <Empty>No closed trades on record.</Empty>
                ) : (
                  <>
                    {/* sm+ : table. Hidden on mobile, where a 5-column table forced a
                        horizontal scroll that clipped the market title off the left edge. */}
                    <div className="hidden sm:block">
                      <Table stickyFirst cols={['Market', 'Result', 'Entry→Exit', 'Realized', 'Date']}>
                        {profile!.tradesClosed.map((t, i) => {
                          const expandable = (t.fills?.length ?? 0) > 0;
                          const open = openRows.has(i);
                          return (
                            <Fragment key={i}>
                              <tr
                                onClick={expandable ? () => toggleRow(i) : undefined}
                                className={[
                                  'border-b border-line/50',
                                  expandable ? 'cursor-pointer hover:bg-bg-soft/60' : 'hover:bg-bg-soft/40',
                                ].join(' ')}>
                                <td className="px-2 py-1.5 pl-4 font-body text-[11px] text-ink-2 max-w-[200px] align-top sticky left-0 bg-surface z-10" title={t.marketTitle ?? undefined}>
                                  <span className="flex items-start gap-1">
                                    {expandable
                                      ? <ChevronRight className={`w-3 h-3 mt-0.5 text-muted shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
                                      : <span className="w-3 shrink-0" />}
                                    <span className="line-clamp-2 break-words">{t.marketTitle ?? '—'}</span>
                                  </span>
                                </td>
                                <td className="px-2 py-1.5"><ResultBadge result={t.result} /></td>
                                <NumCell><EntryExit t={t} /></NumCell>
                                <td className="px-2 py-1.5 text-right tabular-nums">
                                  <span className={`font-body text-[11px] font-semibold ${pnlColor(t.realizedPnl)}`}>
                                    <Redacted value={t.realizedPnl}>{v => fmtPnl(v)}</Redacted>
                                  </span>
                                </td>
                                <td className="px-2 py-1.5 text-right font-body text-[10px] text-muted whitespace-nowrap">{fmtAge(t.timestamp)}</td>
                              </tr>
                              {expandable && open && (
                                <tr className="bg-bg-soft/30">
                                  <td colSpan={5} className="px-4 py-3">
                                    <FillDrawer trade={t} />
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </Table>
                    </div>

                    {/* mobile : stacked cards. The full market title gets its own
                        full-width line (wraps freely, never clipped), then a metrics row. */}
                    <div className="sm:hidden divide-y divide-line/50">
                      {profile!.tradesClosed.map((t, i) => {
                        const expandable = (t.fills?.length ?? 0) > 0;
                        const open = openRows.has(i);
                        return (
                          <div key={i}>
                            <div
                              onClick={expandable ? () => toggleRow(i) : undefined}
                              className={`px-4 py-2.5 ${expandable ? 'cursor-pointer hover:bg-bg-soft/60' : ''}`}>
                              <div className="flex items-start gap-1.5">
                                {expandable
                                  ? <ChevronRight className={`w-3.5 h-3.5 mt-0.5 text-muted shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
                                  : <span className="w-3.5 shrink-0" />}
                                <span className="font-body text-[12px] text-ink-2 break-words leading-snug min-w-0">{t.marketTitle ?? '—'}</span>
                              </div>
                              <div className="mt-1.5 flex items-center gap-x-3 gap-y-1 flex-wrap pl-5 font-body text-[11px]">
                                <ResultBadge result={t.result} />
                                <span className="text-[10px] uppercase tracking-wide text-muted/70">entry→exit</span>
                                <span className="text-[11px] text-ink-2 tabular-nums"><EntryExit t={t} /></span>
                                <span className={`font-semibold tabular-nums ${pnlColor(t.realizedPnl)}`}>
                                  <Redacted value={t.realizedPnl}>{v => fmtPnl(v)}</Redacted>
                                </span>
                                <span className="ml-auto text-[10px] text-muted whitespace-nowrap">{fmtAge(t.timestamp)}</span>
                              </div>
                            </div>
                            {expandable && open && (
                              <div className="bg-bg-soft/30 px-4 py-3"><FillDrawer trade={t} /></div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </MoveSection>
            )}

            {/* Recent activity */}
            {move === 'all' && (
              <MoveSection title={`Recent activity (${profile?.activityRecent?.length ?? 0})`} note="raw fills · newest first">
                {(profile?.activityRecent?.length ?? 0) === 0 ? (
                  <Empty>No recent activity.</Empty>
                ) : (
                  <Table cols={['Side', 'Outcome', 'Price', 'Market', 'Size', 'When']}>
                    {profile!.activityRecent.map((a, i) => {
                      const buy = (a.side ?? '').toUpperCase() === 'BUY';
                      return (
                        <tr key={i} className="border-b border-line/50 hover:bg-bg-soft/40">
                          <td className="px-2 py-1.5">
                            <span className={`font-body text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${buy ? 'bg-mint-tint text-mint-deep' : 'bg-coral-tint text-coral-ink'}`}>
                              {(a.side ?? '—').toUpperCase()}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 font-body text-[11px] text-muted">{a.outcome ?? '—'}</td>
                          <NumCell><Redacted value={a.price}>{v => fmtPrice(v)}</Redacted></NumCell>
                          <Cell title={a.marketTitle}>{a.marketTitle ?? '—'}</Cell>
                          <NumCell>$<Redacted value={a.usdcSize}>{v => fmtSize(v)}</Redacted></NumCell>
                          <td className="px-2 py-1.5 text-right font-body text-[10px] text-muted whitespace-nowrap">{fmtAge(a.timestamp)}</td>
                        </tr>
                      );
                    })}
                  </Table>
                )}
              </MoveSection>
            )}
          </div>

          {/* Disclaimer */}
          <p className="font-body text-[10px] text-muted leading-relaxed border-t border-line pt-4">
            Gross P&amp;L as Polymarket-reported (not net of gas). No Sharpe / drawdown — no equity time-series exists.
            Actor type is a heuristic inference. Open-position P&amp;L is unrealized and can still resolve to zero.
            Entry/exit prices not pinned by the aggregate ledger show &quot;—&quot; (never invented). Not financial advice.
          </p>
        </>
      )}
    </div>
  );
}

// ── Small building blocks ─────────────────────────────────────────────────────

// Expandable drawer for one closed trade: the REAL per-fill breakdown that backs
// this row's entry→exit + realized P&L. Each fill shows side, price (¢), shares,
// USD notional (redacted for free tier), the fill time, and time-to-expiry — how
// long before the market closed the trader entered. All values are real; the
// market close comes from the slug (marketEndTs), null → "close time unavailable".
function FillDrawer({ trade }: { trade: ClosedTrade }) {
  const fills = trade.fills ?? [];
  const endTs = trade.marketEndTs ?? null;
  return (
    <div className="rounded-md border border-line bg-surface">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line/60 gap-2 flex-wrap">
        <span className="font-body text-[10px] uppercase tracking-wide text-muted">Fill breakdown · {fills.length} {fills.length === 1 ? 'fill' : 'fills'}</span>
        <span className="font-body text-[10px] text-muted">
          {endTs != null ? `Market closed ${new Date(endTs * 1000).toLocaleString()}` : 'Market close time unavailable'}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px]">
          <thead>
            <tr className="border-b border-line/50">
              {['Side', 'Price', 'Shares', 'USD', 'Time', 'To expiry'].map((c, i) => (
                <th key={c} className={`px-2 py-1.5 font-body text-[10px] text-muted font-normal ${i === 0 ? 'text-left pl-3' : i >= 1 && i <= 3 ? 'text-right' : 'text-left'}`}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fills.map((f, i) => {
              const buy = (f.side ?? '').toUpperCase() === 'BUY';
              return (
                <tr key={i} className="border-b border-line/30 last:border-b-0">
                  <td className="px-2 py-1.5 pl-3">
                    <span className={`font-body text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${buy ? 'bg-mint-tint text-mint-deep' : 'bg-coral-tint text-coral-ink'}`}>
                      {(f.side ?? '—').toUpperCase()}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-body text-[11px] text-ink-2 tabular-nums">{fmtCents(f.price)}</td>
                  <td className="px-2 py-1.5 text-right font-body text-[11px] text-ink-2 tabular-nums">{fmtSize(f.size)}</td>
                  <td className="px-2 py-1.5 text-right font-body text-[11px] text-ink-2 tabular-nums">$<Redacted value={f.usd}>{v => fmtSize(v)}</Redacted></td>
                  <td className="px-2 py-1.5 font-body text-[10px] text-muted whitespace-nowrap">{new Date(f.timestamp * 1000).toLocaleTimeString()}</td>
                  <td className="px-2 py-1.5 font-body text-[10px] text-muted whitespace-nowrap">{fmtToExpiry(f.secToExpiry)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-body text-[10px] uppercase tracking-wide text-muted mb-1">{label}</div>
      <div className="font-display font-semibold text-lg tabular-nums leading-none">{children}</div>
    </div>
  );
}

function MoveSection({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line last:border-b-0">
      <div className="px-4 py-2 bg-bg-soft/50 flex items-center gap-2">
        <span className="font-body font-medium text-[10px] uppercase tracking-wide text-muted">{title}</span>
        <span className="font-body text-[10px] text-muted/70">· {note}</span>
      </div>
      {children}
    </div>
  );
}

// stickyFirst pins column 0 to the left edge so a wide table scrolling
// horizontally on mobile never clips the identifier column off-screen. Only pass
// it when column 0 is the Market title (open/closed), not for tables whose first
// column is a short badge (recent activity → "Side") — a sticky header with a
// non-sticky body cell would visibly misalign during scroll.
function Table({ cols, children, stickyFirst }: { cols: string[]; children: React.ReactNode; stickyFirst?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px]">
        <thead>
          <tr className="border-b border-line/60">
            {/* No bg on the sticky header cell: the global `th { background: var(--surface) }`
                rule (globals.css) already paints every header cell opaque, so column 0 must
                inherit it too — overriding with bg-surface (the lighter --er-surface) would
                make only this cell mismatch the rest of the header bar. */}
            {cols.map((c, i) => (
              <th key={c} className={`px-2 py-2 font-body text-[10px] text-muted font-normal ${i === 0 ? `text-left pl-4${stickyFirst ? ' sticky left-0 z-20' : ''}` : i >= 2 ? 'text-right' : 'text-left'}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// Market/identifier cell. Wraps to two lines (line-clamp on an inner span — never
// on the <td>, which would break table-cell layout) instead of hard-truncating,
// and can pin to the left edge (sticky) so horizontal scroll never eats the title.
function Cell({ title, children, sticky }: { title?: string | null; children: React.ReactNode; sticky?: boolean }) {
  return (
    <td className={`px-2 py-1.5 pl-4 font-body text-[11px] text-ink-2 max-w-[200px] align-top${sticky ? ' sticky left-0 bg-surface z-10' : ''}`} title={title ?? undefined}>
      <span className="line-clamp-2 break-words">{children}</span>
    </td>
  );
}
function NumCell({ children }: { children: React.ReactNode }) {
  return <td className="px-2 py-1.5 text-right font-body text-[11px] text-ink-2 tabular-nums">{children}</td>;
}
function OutcomeCell({ outcome }: { outcome: string | null }) {
  const up = outcome === 'Up' || outcome === 'Yes';
  return (
    <td className="px-2 py-1.5">
      {outcome
        ? <span className={`font-body text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${up ? 'bg-mint-tint text-mint-deep' : 'bg-coral-tint text-coral-ink'}`}>{outcome}</span>
        : <span className="font-body text-[11px] text-muted">—</span>}
    </td>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-center font-body text-[11px] text-muted">{children}</div>;
}

// ── Shared closed-trade cell renderers (used by BOTH the sm+ table and the mobile
// card list, so the two layouts never drift) ─────────────────────────────────────
function ResultBadge({ result }: { result: string | null }) {
  return (
    <span className={[
      'font-body text-[10px] font-semibold px-1.5 py-0.5 rounded-md',
      result === 'won' ? 'bg-mint-tint text-mint-deep'
        : result === 'lost' ? 'bg-coral-tint text-coral-ink'
        : 'bg-bg-soft text-muted',
    ].join(' ')}>{result}</span>
  );
}
// Entry→Exit prices — or a self-explanatory "— → —" when the observed fills could
// not be reconciled with the realized P&L. HONEST-ENGINE: never invented; the title
// spells out WHY so a withheld pair reads as a deliberate integrity guard, not a bug.
function EntryExit({ t }: { t: ClosedTrade }) {
  const withheld = t.entryPrice == null && t.exitPrice == null;
  return (
    <span className="font-mono" title={withheld
      ? 'Entry/exit withheld — the observed fills don’t reconcile with the realized P&L (fill history may be incomplete). Never invented.'
      : undefined}>
      {fmtPrice(t.entryPrice)}<span className="text-muted/50"> → </span>{fmtPrice(t.exitPrice)}
    </span>
  );
}
