'use client';

import { useEffect, useState } from 'react';
import SectionHelp from '@/app/components/SectionHelp';
import { Redacted } from '@/app/components/ui/Redacted';

// ── Types ─────────────────────────────────────────────────────────────────────
// wins/losses/winRatePct/totalPnlUsdc/avgPnlPerMarket/avgExposurePerMarket:
// null on free tier (server-side redaction, lib/paid-gating.ts).

interface WalletPattern {
  avgEntryTimingPct: number | null;
  timingLabel: string;
  sideBias: string;
  upBiasRate: number;
  avgTradesPerMarket: number;
  avgExposurePerMarket: number | null;
  durationsTraded: string[];
}

interface TopWallet {
  wallet: string;
  name: string;
  resolvedMarkets: number;
  wins: number | null;
  losses: number | null;
  winRatePct: number | null;
  totalPnlUsdc: number | null;
  avgPnlPerMarket: number | null;
  pattern: WalletPattern;
  disclaimer: string;
}

interface RecentMarket {
  title: string;
  winner: string;
  tradeCount: number;
  processedAt: string;
}

interface WhaleData {
  agentStatus: 'running' | 'stale' | 'offline';
  updatedAt: string | null;
  windowDays: number;
  minMarketsToRank: number;
  marketsProcessed: number;
  marketsInWindow: number;
  uniqueWallets: number;
  qualifiedWallets: number;
  topWallets: TopWallet[];
  recentMarkets: RecentMarket[];
  stats: { disclaimer: string } | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPnl(v: number) {
  const sign = v >= 0 ? '+' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function pnlClass(v: number) {
  return v > 0 ? 'text-mint-deep' : v < 0 ? 'text-coral-ink' : 'text-muted';
}

function shortWallet(w: string) {
  return w.length > 10 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AgentBanner({ status, updatedAt }: { status: string; updatedAt: string | null }) {
  const colors: Record<string, string> = {
    running: 'border-mint-deep/30 text-mint-deep',
    stale:   'border-gold/30 text-gold',
    offline: 'border-coral-ink/30 text-coral-ink',
  };
  const age = updatedAt
    ? Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60_000)
    : null;

  return (
    <div className={`border px-3 py-1.5 flex items-center gap-3 font-body text-[10px] rounded-card ${colors[status] ?? colors.offline}`}>
      <span className="uppercase tracking-widest">{status}</span>
      {age !== null && (
        <span className="text-muted/50">updated {age}m ago</span>
      )}
      <span className="text-muted/30 ml-auto">agent17-poly-whales · ≤0.5 req/s · zero Claude</span>
    </div>
  );
}

function WinRate({ pct }: { pct: number | null }) {
  const color = pct == null ? 'text-muted' : pct >= 60 ? 'text-mint-deep' : pct >= 50 ? 'text-gold' : 'text-coral-ink';
  return <span className={`font-mono font-bold ${color}`}><Redacted value={pct}>{v => `${v.toFixed(1)}%`}</Redacted></span>;
}

function WalletCard({ w, rank }: { w: TopWallet; rank: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-line/40 bg-surface/30 rounded-card">
      {/* Header row */}
      <button
        className="w-full px-4 py-3 flex items-center gap-4 text-left hover:bg-bg-soft/20 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <span className="font-mono text-[10px] text-muted/40 w-5 shrink-0">#{rank}</span>

        <div className="flex-1 min-w-0">
          <div className="font-body text-[11px] text-ink-2 truncate">
            {w.name !== shortWallet(w.wallet) && w.name ? w.name : ''}
            <span className="text-muted/50 ml-1 font-mono">{shortWallet(w.wallet)}</span>
          </div>
          <div className="font-body text-[10px] text-muted/40 mt-0.5">
            {w.resolvedMarkets} markets · <Redacted value={w.wins}>{v => String(v)}</Redacted>W / <Redacted value={w.losses}>{v => String(v)}</Redacted>L
          </div>
        </div>

        <div className="text-right shrink-0">
          <WinRate pct={w.winRatePct} />
          <div className={`font-mono text-[10px] mt-0.5 ${w.totalPnlUsdc != null ? pnlClass(w.totalPnlUsdc) : 'text-muted'}`}>
            <Redacted value={w.totalPnlUsdc}>{v => fmtPnl(v)}</Redacted> total
          </div>
        </div>

        <span className="font-body text-[9px] text-muted/30 ml-2">{open ? '▾' : '▸'}</span>
      </button>

      {/* Expanded pattern detail */}
      {open && (
        <div className="border-t border-line/30 px-4 py-3 grid grid-cols-2 gap-x-6 gap-y-2">
          <div>
            <div className="font-body text-[9px] uppercase tracking-widest text-muted/50 mb-1">Entry timing</div>
            <div className="font-body text-[11px] text-ink-2">{w.pattern.timingLabel}</div>
            {w.pattern.avgEntryTimingPct !== null && (
              <div className="font-mono text-[10px] text-muted/40">{w.pattern.avgEntryTimingPct.toFixed(1)}% into window (avg)</div>
            )}
          </div>
          <div>
            <div className="font-body text-[9px] uppercase tracking-widest text-muted/50 mb-1">Side bias</div>
            <div className="font-body text-[11px] text-ink-2">{w.pattern.sideBias}</div>
            <div className="font-mono text-[10px] text-muted/40">Up-bet rate: {w.pattern.upBiasRate.toFixed(1)}%</div>
          </div>
          <div>
            <div className="font-body text-[9px] uppercase tracking-widest text-muted/50 mb-1">Activity</div>
            <div className="font-mono text-[11px] text-ink-2">{w.pattern.avgTradesPerMarket.toFixed(1)} trades/market</div>
            <div className="font-mono text-[10px] text-muted/40">
              avg $<Redacted value={w.pattern.avgExposurePerMarket}>{v => v.toFixed(0)}</Redacted> USDC/market
            </div>
          </div>
          <div>
            <div className="font-body text-[9px] uppercase tracking-widest text-muted/50 mb-1">Markets traded</div>
            <div className="font-body text-[11px] text-ink-2">
              {w.pattern.durationsTraded.length > 0 ? w.pattern.durationsTraded.join(', ') : '—'}
            </div>
            <div className="font-mono text-[10px] text-muted/40">
              avg <Redacted value={w.avgPnlPerMarket}>{v => fmtPnl(v)}</Redacted>/market
            </div>
          </div>

          {/* Disclaimer */}
          <div className="col-span-2 mt-1 border-t border-line/20 pt-2">
            <p className="font-body text-[9px] text-muted/40 leading-relaxed">{w.disclaimer}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WhalesPage() {
  const [data, setData]       = useState<WhaleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await fetch('/api/poly-whales', { cache: 'no-store' });
      const j = await r.json();
      setData(j);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000); // refresh every 60s (agent runs every 5m)
    return () => clearInterval(id);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="font-display font-semibold text-lg text-ink tracking-tight">Whale Watch</h1>
        <p className="font-body text-[11px] text-muted mt-1">
          Polymarket short-crypto-market wallets ranked by realized PnL — read-only, observational only
        </p>
      </div>

      <SectionHelp section="whales" />

      {loading && (
        <div className="font-body text-[11px] text-muted/50">Loading…</div>
      )}

      {error && (
        <div className="font-body text-[11px] text-coral-ink">Error: {error}</div>
      )}

      {data && (
        <>
          <AgentBanner status={data.agentStatus} updatedAt={data.updatedAt} />

          {/* Stats bar */}
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Markets processed', value: data.marketsProcessed },
              { label: `Markets (${data.windowDays}d window)`, value: data.marketsInWindow },
              { label: 'Unique wallets seen', value: data.uniqueWallets },
              { label: `Ranked (≥${data.minMarketsToRank} mkts)`, value: data.qualifiedWallets },
            ].map(({ label, value }) => (
              <div key={label} className="border border-line/30 bg-surface/20 px-3 py-2 rounded-card">
                <div className="font-body text-[9px] uppercase tracking-widest text-muted/50">{label}</div>
                <div className="font-mono text-lg font-bold text-ink-2 mt-0.5">{value}</div>
              </div>
            ))}
          </div>

          {/* Disclaimer block */}
          <div className="border border-gold/20 bg-gold/5 px-4 py-3 space-y-1 rounded-card">
            <div className="font-body text-[9px] uppercase tracking-widest text-gold/70">Read before interpreting</div>
            <p className="font-body text-[10px] text-muted/70 leading-relaxed">
              {data.stats?.disclaimer ?? 'Requires minimum resolved markets to rank a wallet. Most consistently-profitable wallets in short-duration markets are latency bots with infrastructure advantages not replicable by manual traders.'}
            </p>
            <p className="font-body text-[10px] text-muted/50 leading-relaxed">
              This is observed behavior — WHAT they did, not WHY. PnL is computed from public trade data; wallet identities are pseudonymous (proxyWallet). No copy-trade signal is implied. Patterns may reflect bot strategies with microsecond latency advantages.
            </p>
          </div>

          {/* Top wallets */}
          {data.topWallets.length === 0 ? (
            <div className="border border-line/30 bg-surface/20 px-4 py-8 text-center rounded-card">
              <div className="font-body text-[11px] text-muted/50">
                {data.agentStatus === 'offline'
                  ? 'Agent offline — no data yet'
                  : data.marketsProcessed === 0
                    ? 'No resolved markets processed yet — agent running, first scan in progress'
                    : `${data.uniqueWallets} wallets seen across ${data.marketsInWindow} markets — none yet meet the ≥${data.minMarketsToRank} market minimum for ranking`}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="font-body text-[9px] uppercase tracking-widest text-muted/50">
                Top {data.topWallets.length} wallets by realized PnL · {data.windowDays}-day rolling window · click to expand pattern
              </div>
              {data.topWallets.map((w, i) => (
                <WalletCard key={w.wallet} w={w} rank={i + 1} />
              ))}
            </div>
          )}

          {/* Recent markets processed */}
          {data.recentMarkets.length > 0 && (
            <div className="space-y-2">
              <div className="font-body text-[9px] uppercase tracking-widest text-muted/50">
                Recently processed markets
              </div>
              <div className="border border-line/30 overflow-hidden rounded-card">
                <table className="w-full font-body text-[10px]">
                  <thead>
                    <tr className="border-b border-line/30 text-muted/40">
                      <th className="text-left px-3 py-2 font-normal">Market</th>
                      <th className="text-left px-3 py-2 font-normal">Winner</th>
                      <th className="text-right px-3 py-2 font-normal">Trades</th>
                      <th className="text-right px-3 py-2 font-normal">Processed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentMarkets.map((m, i) => (
                      <tr key={i} className="border-b border-line/20 last:border-0">
                        <td className="px-3 py-1.5 text-ink-2">{m.title}</td>
                        <td className="px-3 py-1.5 text-muted">
                          <span className={m.winner === 'Up' ? 'text-mint-deep' : 'text-coral-ink'}>{m.winner}</span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-muted">{m.tradeCount}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-muted/40">
                          {new Date(m.processedAt).toLocaleTimeString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
