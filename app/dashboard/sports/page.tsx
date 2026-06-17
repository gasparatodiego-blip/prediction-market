'use client';

import { useEffect, useState, useCallback } from 'react';
import SectionHelp from '@/app/components/SectionHelp';
import type { SportsResponse, SportsArb, ArbLeg } from '@/app/api/sports/route';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return '—'; }
}

function freshnessLabel(ageMs: number): { label: string; cls: string } {
  const m = Math.floor(ageMs / 60_000);
  if (m < 5)  return { label: `${m}m ago`, cls: 'text-positive' };
  if (m < 20) return { label: `${m}m ago`, cls: 'text-warning' };
  return { label: `${m}m ago`, cls: 'text-negative' };
}

function sportLabel(key: string): string {
  const m: Record<string, string> = {
    soccer_epl:                  'Premier League',
    soccer_uefa_champs_league:   'Champions League',
    soccer_italy_serie_a:        'Serie A',
    basketball_nba:              'NBA',
    americanfootball_nfl:        'NFL',
    tennis_atp_wimbledon:        'ATP Wimbledon',
    tennis_wta_wimbledon:        'WTA Wimbledon',
  };
  return m[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBar({ data }: { data: SportsResponse | null }) {
  if (!data) return (
    <div className="h-6 flex items-center gap-3 font-mono text-[10px] text-text-muted">
      <span className="animate-pulse">LOADING…</span>
    </div>
  );

  const statusCls = data.ok && !data.isStale && !data.paused
    ? 'text-positive'
    : data.paused ? 'text-negative' : 'text-warning';
  const statusLabel = data.paused ? 'PAUSED — LOW CREDITS'
    : !data.ok ? 'OFFLINE'
    : data.isStale ? 'STALE'
    : 'LIVE';

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-text-muted">
      <span className={`font-semibold tracking-widest ${statusCls}`}>{statusLabel}</span>
      {data.ok && (
        <>
          <span>{data.totalEvents} EVENTS SCANNED</span>
          <span>{data.sportsChecked.map(sportLabel).join(' · ') || '—'}</span>
          {data.creditsRemaining != null && (
            <span className={data.creditsRemaining < 100 ? 'text-warning' : ''}>
              API CREDITS LEFT: {data.creditsRemaining}
            </span>
          )}
          {data.ageMinutes != null && (
            <span>UPDATED {data.ageMinutes}m AGO</span>
          )}
        </>
      )}
    </div>
  );
}

function ArbCard({ arb }: { arb: SportsArb }) {
  const fresh = freshnessLabel(arb.oddsAgeMs);

  return (
    <div className={`border ${arb.isStale ? 'border-border opacity-60' : 'border-accent/40 bg-bg-panel'} p-4 space-y-3`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted mb-0.5">
            {sportLabel(arb.sport)}
          </p>
          <p className="font-mono text-sm font-semibold text-text-primary leading-tight">
            {arb.homeTeam} <span className="text-text-muted font-normal">vs</span> {arb.awayTeam}
          </p>
          <p className="font-mono text-[10px] text-text-muted mt-0.5">
            STARTS {fmtTime(arb.commenceTime)}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="font-mono text-lg font-bold text-positive tabular-nums leading-none">
            +{arb.netMargin.toFixed(2)}%
          </p>
          <p className="font-mono text-[9px] text-text-muted mt-0.5">NET MARGIN</p>
          <p className={`font-mono text-[9px] mt-1 ${fresh.cls}`}>
            ODDS {fresh.label}
          </p>
        </div>
      </div>

      {/* Leg table */}
      <div className="border border-border divide-y divide-border">
        <div className="grid grid-cols-4 px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-text-muted">
          <span>Outcome</span>
          <span>Book</span>
          <span className="text-right">Odds</span>
          <span className="text-right">Stake / $100</span>
        </div>
        {arb.legs.map((leg: ArbLeg, i: number) => (
          <div key={i} className="grid grid-cols-4 px-3 py-2 font-mono text-[11px]">
            <span className="text-text-primary truncate pr-2">{leg.outcome}</span>
            <span className="text-text-secondary truncate pr-2">{leg.bookmaker}</span>
            <span className="text-right text-accent tabular-nums">{leg.odds.toFixed(2)}</span>
            <span className="text-right text-positive tabular-nums">${leg.stake.toFixed(2)}</span>
          </div>
        ))}
      </div>

      {/* Math summary */}
      <div className="flex flex-wrap gap-x-6 gap-y-0.5 font-mono text-[10px] text-text-muted pt-1 border-t border-border">
        <span>IMPLIED SUM: <span className="text-accent">{(arb.impliedSum * 100).toFixed(2)}%</span></span>
        <span>GUARANTEED PAYOUT: <span className="text-positive">${(100 / arb.impliedSum).toFixed(2)}</span> per $100</span>
        <span>GROSS ARB: <span className="text-text-secondary">{arb.grossMargin.toFixed(2)}%</span></span>
        {arb.isStale && (
          <span className="text-negative font-semibold">⚠ STALE ODDS — verify before betting</span>
        )}
      </div>
    </div>
  );
}

function NoArbNotice({ data }: { data: SportsResponse }) {
  return (
    <div className="border border-border bg-bg-panel px-4 py-6 font-mono text-center space-y-2">
      <p className="text-sm text-text-secondary">No arbitrage opportunities found</p>
      <p className="text-[10px] text-text-muted">
        {data.totalEvents > 0
          ? `Scanned ${data.totalEvents} events — all implied sums ≥ 1 (no guaranteed profit)`
          : 'No events returned — check that active leagues are in WANTED_SPORTS config'}
      </p>
    </div>
  );
}

function OfflineNotice({ paused, creditsRemaining }: { paused: boolean; creditsRemaining: number | null }) {
  return (
    <div className="border border-warning/30 bg-warning/5 px-4 py-4 flex flex-wrap items-start gap-x-6 gap-y-2">
      <span className="font-mono text-[10px] uppercase tracking-widest text-warning shrink-0 mt-px">
        {paused ? 'PAUSED' : 'OFFLINE'}
      </span>
      <div className="space-y-1">
        <p className="font-mono text-[11px] text-text-secondary leading-relaxed">
          {paused
            ? `OddsAPI credit floor reached (${creditsRemaining ?? '?'} remaining). Polling paused to protect monthly quota.`
            : 'Sports agent is not running. Set ODDS_API_LIVE=true in .env.local and register agent12-sports in ecosystem.config.js to activate live scanning.'}
        </p>
        <p className="font-mono text-[10px] text-text-muted/60">
          Signal-only — no bets are placed. Verify odds independently before trading.
        </p>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SportsPage() {
  const [data, setData]     = useState<SportsResponse | null>(null);
  const [error, setError]   = useState(false);
  const [lastFetch, setLastFetch] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/sports', { cache: 'no-store' });
      if (!r.ok) { setError(true); return; }
      setData(await r.json());
      setLastFetch(Date.now());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5 * 60_000);  // refresh every 5 min
    return () => clearInterval(id);
  }, [load]);

  const isLive = data?.ok && !data.isStale && !data.paused;
  const arbs   = data?.arbOpportunities ?? [];

  return (
    <div className="max-w-[1100px] mx-auto px-4 py-6 space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="font-mono text-sm uppercase tracking-widest text-text-primary">
            SPORTS ARBITRAGE
          </h1>
          <p className="font-mono text-[10px] text-text-muted mt-0.5">
            CROSS-BOOKMAKER SUREBETS · SIGNAL ONLY · NO BETS PLACED
          </p>
        </div>
        <StatusBar data={data} />
      </div>

      <SectionHelp section="sports" />

      {/* ── Content ────────────────────────────────────────────────────────── */}
      {error && (
        <div className="border border-negative/30 bg-negative/5 px-4 py-3 font-mono text-[11px] text-negative">
          Failed to load sports data — check agent12-sports logs.
        </div>
      )}

      {!error && !isLive && (
        <OfflineNotice paused={data?.paused ?? false} creditsRemaining={data?.creditsRemaining ?? null} />
      )}

      {!error && isLive && arbs.length === 0 && data && (
        <NoArbNotice data={data} />
      )}

      {arbs.length > 0 && (
        <div className="space-y-3">
          <p className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
            {arbs.length} OPPORTUNITY{arbs.length !== 1 ? 'IES' : 'Y'} — RANKED BY NET MARGIN
          </p>
          {arbs.map((arb: SportsArb) => (
            <ArbCard key={arb.eventId} arb={arb} />
          ))}
        </div>
      )}

      {/* ── Disclaimer ─────────────────────────────────────────────────────── */}
      <div className="border-t border-border pt-5">
        <div className="space-y-1.5 font-mono text-[10px] text-text-muted/70 leading-relaxed">
          <p>
            <span className="text-text-muted font-semibold">HOW TO READ THIS:</span>{' '}
            Each card shows the best decimal odds for each outcome across different bookmakers.
            Stake sizes are calculated for an equalized guaranteed payout on $100 bankroll.
            Net margin = actual profit / $100 staked = (1/impliedSum − 1) × 100.
          </p>
          <p>
            <span className="text-text-muted font-semibold">EXECUTION RISK:</span>{' '}
            Odds change between the time we fetch them and the time you place bets.
            Always verify both sides of the arb before committing capital.
            Stale odds (flagged red) are especially risky — the edge may be gone.
          </p>
          <p>
            <span className="text-text-muted font-semibold">ACCOUNT RISK:</span>{' '}
            Bookmakers may limit or close accounts that consistently bet arbs.
            This tool is signal-only and does not place bets. Not financial advice.
          </p>
          <p className="text-text-muted/40">
            Data via The Odds API · OddsAPI free quota guarded (stops at {50} credits remaining) ·
            Poll interval 45 min · h2h markets only
          </p>
        </div>
      </div>
    </div>
  );
}
