'use client';

import { useEffect, useState } from 'react';
import SectionHelp from '@/app/components/SectionHelp';
import type {
  SnapshotResponse,
  SnapshotOpportunity,
  SnapshotQuarantine,
} from '@/app/api/sports-snapshot/route';

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_MS          = 5 * 60_000;  // re-fetch every 5 min (data only changes when scanner runs)
const CREDIT_TOTAL     = 500;         // OddsAPI free-tier monthly budget
const CREDIT_LOW_FLOOR = 60;          // amber warning below this

const SPORT_LABELS: Record<string, string> = {
  soccer_epl:                  'Premier League',
  soccer_uefa_champs_league:   'Champions League',
  soccer_italy_serie_a:        'Serie A',
  soccer_spain_la_liga:        'La Liga',
  basketball_nba:              'NBA',
  americanfootball_nfl:        'NFL',
  icehockey_nhl:               'NHL',
  baseball_mlb:                'MLB',
  tennis_atp:                  'ATP',
  tennis_wta:                  'WTA',
};

function sportLabel(key: string): string {
  return SPORT_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ago(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function relativeTime(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return 'soon';
    const m = Math.floor(ms / 60_000);
    if (m < 60)   return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48)   return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch { return '—'; }
}

function absoluteTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function commenceRelative(iso: string): string {
  try {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms < 0) return 'started';
    const h = Math.floor(ms / 3_600_000);
    if (h < 1)  return `${Math.floor(ms / 60_000)}m`;
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  } catch { return '—'; }
}

// ── Disclaimer chip (same amber expandable pattern as ObservedModelChip) ──────

const DISCLAIMER_TEXT =
  'Snapshot scan of EU h2h odds via OddsAPI. NOT a live feed — data is from the last manual scan run. ' +
  'Surebets shown survive a minimum-bookmakers gate (≥4 books), a median outlier filter that removes ' +
  'suspiciously generous prices, and a plausibility cap (ROI > 6% → quarantine). ' +
  'Preview only — no orders are placed. Always verify odds independently before acting.';

function DisclaimerChip() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center">
      <button
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1 px-2 py-0.5 border border-amber-600/50
          bg-amber-950/30 text-amber-400 font-mono text-[9px] uppercase tracking-wide
          hover:bg-amber-950/50 transition-colors"
        aria-expanded={open}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400/70 shrink-0" />
        SNAPSHOT · preview only
        <span className="text-amber-600 ml-0.5">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <span className="absolute top-full left-0 z-20 mt-1.5 w-80 border border-amber-600/40
          bg-zinc-900 shadow-lg px-3 py-2.5">
          <p className="font-mono text-[10px] text-amber-300/80 leading-relaxed">
            {DISCLAIMER_TEXT}
          </p>
          <button
            onClick={() => setOpen(false)}
            className="font-mono text-[9px] text-zinc-600 hover:text-zinc-400 mt-1.5"
          >
            close ✕
          </button>
        </span>
      )}
    </span>
  );
}

// ── Credit meter ──────────────────────────────────────────────────────────────

function CreditMeter({ remaining, used }: { remaining: number | null; used: number | null }) {
  if (remaining == null) {
    return (
      <div className="border border-border bg-bg-panel px-4 py-3 space-y-1.5">
        <div className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
          OddsAPI monthly budget
        </div>
        <div className="font-mono text-[10px] text-text-muted/50">
          Credit data not yet available — run a scan first.
        </div>
      </div>
    );
  }

  const pct     = Math.max(0, Math.min(100, (remaining / CREDIT_TOTAL) * 100));
  const isLow   = remaining < CREDIT_LOW_FLOOR;
  const barCls  = isLow
    ? 'bg-warning/70'
    : pct > 40
      ? 'bg-positive/60'
      : 'bg-positive/40';
  const numCls  = isLow ? 'text-warning' : 'text-text-secondary';

  return (
    <div className={`border px-4 py-3 space-y-2 ${isLow ? 'border-warning/30 bg-warning/5' : 'border-border bg-bg-panel'}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
          OddsAPI monthly budget
        </span>
        <span className={`font-mono text-[10px] ${numCls}`}>
          {remaining} / {CREDIT_TOTAL} remaining{used != null ? ` · ${used} used` : ''}
          {isLow && <span className="ml-1.5 text-warning font-semibold">LOW</span>}
        </span>
      </div>
      <div className="h-1.5 bg-bg-elevated rounded-sm overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${barCls}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="font-mono text-[9px] text-text-muted/50 leading-relaxed">
        Each /odds request costs 1 credit. The /sports discovery call is free.
        Scanner respects a {CREDIT_LOW_FLOOR}-credit safety floor and stops automatically.
      </p>
    </div>
  );
}

// ── Opportunity card ──────────────────────────────────────────────────────────

function OpportunityCard({ opp }: { opp: SnapshotOpportunity }) {
  const inMs = new Date(opp.commenceTime).getTime() - Date.now();
  const isStarted = inMs < 0;

  return (
    <div className="border border-border bg-bg-panel p-4 space-y-3">

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-1">
            <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted">
              {sportLabel(opp.sport)}
            </span>
            <span className="font-mono text-[9px] text-text-muted/40">·</span>
            <span className="font-mono text-[9px] uppercase tracking-wide border border-border px-1 py-px text-text-muted">
              {opp.type}
            </span>
            {opp.outliersRemoved && (
              <span
                title="Arb survived removal of outlier bookmaker prices — stronger trust signal."
                className="font-mono text-[9px] uppercase tracking-wide border border-positive/30 bg-positive/5 text-positive/70 px-1 py-px"
              >
                OUTLIER-FILTERED
              </span>
            )}
            {isStarted && (
              <span className="font-mono text-[9px] uppercase border border-warning/40 text-warning px-1 py-px">
                STARTED
              </span>
            )}
          </div>
          <p className="font-mono text-sm font-semibold text-text-primary leading-tight">
            {opp.eventName}
          </p>
          <p className="font-mono text-[10px] text-text-muted mt-0.5">
            {isStarted
              ? 'Match already started — verify odds are still valid'
              : `Starts in ${commenceRelative(opp.commenceTime)} · ${absoluteTime(opp.commenceTime)}`}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono text-xl font-bold text-positive tabular-nums leading-none">
            +{opp.roiPct.toFixed(2)}%
          </div>
          <div className="font-mono text-[9px] text-text-muted mt-0.5">ROI</div>
          <div className="font-mono text-[10px] text-text-muted/60 mt-0.5">
            impl. sum {(opp.impliedSum * 100).toFixed(2)}%
          </div>
        </div>
      </div>

      {/* Leg table */}
      <div className="border border-border divide-y divide-border">
        <div className="grid grid-cols-4 px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-text-muted">
          <span>Outcome</span>
          <span>Bookmaker</span>
          <span className="text-right">Best odd</span>
          <span className="text-right">Stake %</span>
        </div>
        {opp.legs.map((leg, i) => (
          <div key={i} className="grid grid-cols-4 px-3 py-2 font-mono text-[11px]">
            <span className="text-text-primary truncate pr-2">{leg.outcome}</span>
            <span className="text-text-secondary truncate pr-2">{leg.bookmaker}</span>
            <span className="text-right text-accent tabular-nums">{leg.odd.toFixed(3)}</span>
            <span className="text-right text-positive tabular-nums">{leg.stakePct.toFixed(1)}%</span>
          </div>
        ))}
      </div>

      {/* Footer note */}
      <p className="font-mono text-[9px] text-text-muted/50 leading-relaxed">
        Stake % is a preview hedge split for equalized payout. No orders placed by this tool.
        Verify both sides independently before acting — odds change in seconds.
        {opp.numBookmakers != null && ` ${opp.numBookmakers} books quoted this event.`}
      </p>
    </div>
  );
}

// ── Quarantine section ────────────────────────────────────────────────────────

function QuarantineSection({ items }: { items: SnapshotQuarantine[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  return (
    <div className="border border-border/50">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-bg-elevated/20 transition-colors duration-100"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
            Quarantined — excluded, suspected bad data
          </span>
          <span className="font-mono text-[9px] text-text-muted/50 border border-border px-1 py-px">
            {items.length}
          </span>
        </div>
        <span className="font-mono text-[10px] text-text-muted/40">{open ? '▲ close' : '▼ show'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-border/40 space-y-3 pt-3">
          <p className="font-mono text-[10px] text-text-muted/60 leading-relaxed">
            These events showed a surebet ROI above {6}% after outlier removal — implausibly high for
            real h2h markets. Most likely a data error (stale price, feed glitch, or bad scrape).
            They are listed here for transparency only and must NOT be acted upon.
          </p>
          <div className="space-y-1">
            {items.map((q, i) => (
              <div
                key={i}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 border border-border/30 bg-bg-base/50"
              >
                <span className="font-mono text-[10px] text-text-muted/50">{sportLabel(q.sport)}</span>
                <span className="font-mono text-[11px] text-text-muted">{q.eventName}</span>
                <span className="font-mono text-[10px] text-warning/60 tabular-nums ml-auto">
                  +{q.roiPct.toFixed(2)}%
                </span>
                <span className="font-mono text-[9px] text-text-muted/40">{q.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SportsSnapshotPage() {
  const [data,      setData]      = useState<SnapshotResponse | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  async function load() {
    try {
      const res  = await fetch('/api/sports-snapshot', { cache: 'no-store' });
      const json = await res.json() as SnapshotResponse;
      setData(json);
      setLastFetch(new Date());
    } catch { /* keep stale, stay silent */ }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const opps       = data?.opportunities ?? [];
  const qItems     = data?.quarantine    ?? [];
  const scanned    = data?.sportsScanned ?? [];
  const lastUpdated = data?.lastUpdated ?? null;
  const isMissing  = data?.missing ?? false;

  return (
    <div className="max-w-[900px] mx-auto px-4 py-6 space-y-5">

      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="font-mono text-sm uppercase tracking-widest text-text-primary">
              SPORTS ARBITRAGE
            </h1>
            {/* SNAPSHOT badge — static (not pulsing like LIVE) */}
            <span className="font-mono text-[9px] uppercase tracking-widest px-2 py-0.5 border border-border text-text-muted">
              SNAPSHOT
            </span>
            {lastUpdated && (
              <span
                title={absoluteTime(lastUpdated)}
                className="font-mono text-[10px] text-text-muted cursor-default"
              >
                updated {relativeTime(lastUpdated)}
              </span>
            )}
          </div>
          <p className="font-mono text-[10px] text-text-muted mt-0.5">
            CROSS-BOOKMAKER SUREBETS · EU H2H · PERIODIC SNAPSHOT · NO ORDERS PLACED
          </p>
        </div>
        <DisclaimerChip />
      </div>

      {/* How to use */}
      <SectionHelp section="sports" />

      {/* ── Missing file state ─────────────────────────────────────────────── */}
      {isMissing && (
        <div className="border border-border bg-bg-panel px-4 py-8 text-center space-y-3">
          <p className="font-mono text-sm text-text-secondary">No snapshot yet</p>
          <p className="font-mono text-[11px] text-text-muted leading-relaxed">
            Run a scan to populate opportunities data:
          </p>
          <code className="font-mono text-[11px] text-accent bg-bg-elevated px-3 py-1.5 block w-fit mx-auto border border-border">
            node agents/agent12-sports.js
          </code>
          <p className="font-mono text-[10px] text-text-muted/50">
            Each scan uses ~1 OddsAPI credit per sport. Check credits.json before running.
          </p>
        </div>
      )}

      {/* ── Data available ─────────────────────────────────────────────────── */}
      {!isMissing && data && (
        <>
          {/* Credit meter */}
          <CreditMeter
            remaining={data.creditsRemaining}
            used={data.creditsUsed}
          />

          {/* Sports-scanned row */}
          {scanned.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted mr-1">
                  scanned:
                </span>
                {scanned.map(key => (
                  <span
                    key={key}
                    className="font-mono text-[10px] px-2 py-0.5 border border-border bg-bg-elevated text-text-secondary"
                  >
                    {sportLabel(key)}
                  </span>
                ))}
              </div>
              <p className="font-mono text-[9px] text-text-muted/50">
                regions: {(data.regions ?? []).join(', ')} · markets: h2h
                {data.ageMinutes != null && ` · snapshot ${data.ageMinutes}m old`}
                {lastFetch && ` · page fetched ${ago(lastFetch.toISOString())}`}
              </p>
            </div>
          )}

          {/* Stale banner */}
          {data.stale && lastUpdated && (
            <div className="border border-warning/30 bg-warning/5 px-4 py-2.5 font-mono text-[11px] text-warning/80">
              Snapshot is over 24h old (last: {absoluteTime(lastUpdated)}).
              Run another scan when the monthly credit budget allows.
            </div>
          )}

          {/* Opportunities */}
          {opps.length === 0 ? (
            <div className="border border-border bg-bg-panel px-4 py-8 text-center space-y-2">
              <p className="font-mono text-sm text-text-secondary">
                0 cashable surebets in this snapshot
              </p>
              <p className="font-mono text-[11px] text-text-muted leading-relaxed max-w-md mx-auto">
                The scanned markets are efficiently priced right now.
                This is the expected result most of the time — genuine arb windows are rare and
                close in seconds. No arbs is honest, not a bug.
              </p>
              {scanned.length > 0 && (
                <p className="font-mono text-[10px] text-text-muted/50 mt-2">
                  {scanned.length} sport{scanned.length > 1 ? 's' : ''} scanned · outlier filter active ·
                  events with &lt;4 books excluded
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
                  {opps.length} surebet{opps.length !== 1 ? 's' : ''} — ranked by ROI
                </span>
                <span className="font-mono text-[9px] text-text-muted/50">
                  outlier-filtered · ≥4 bookmakers · ROI ≤ 6% plausibility cap
                </span>
              </div>
              {opps.map((opp, i) => (
                <OpportunityCard key={i} opp={opp} />
              ))}
            </div>
          )}

          {/* Quarantine */}
          <QuarantineSection items={qItems} />
        </>
      )}

      {/* Loading skeleton */}
      {!data && (
        <div className="space-y-3 animate-pulse">
          <div className="h-16 bg-bg-elevated border border-border" />
          <div className="h-24 bg-bg-elevated border border-border" />
          <div className="h-32 bg-bg-elevated border border-border" />
        </div>
      )}

      {/* Disclaimer footer */}
      <div className="border-t border-border pt-4 space-y-1">
        <p className="font-mono text-[10px] text-text-muted/50 leading-relaxed">
          Snapshot-mode scanner only — does NOT place orders or access any bookmaker account.
          Stake percentages are illustrative hedge splits for equalized payout on any bankroll size.
          Bookmakers limit arb accounts; always verify odds manually before acting.
        </p>
        <p className="font-mono text-[10px] text-text-muted/40">
          Data via The Odds API (EU region, h2h markets) · credit-safe scanner (floor: 30 remaining) ·
          run manually with <code>node agents/agent12-sports.js</code>
        </p>
      </div>

    </div>
  );
}
