'use client';

import { useEffect, useState } from 'react';
import SectionHelp from '@/app/components/SectionHelp';
import type {
  SnapshotResponse,
  SnapshotOpportunity,
  SnapshotQuarantine,
  ScannedEvent,
  ScannedEventLeg,
  SnapshotLeg,
  Settlement,
  SportScanEntry,
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

// Static bookmaker homepage map (key → URL). OddsAPI returns no betslip links on our plan.
// Prefer these URLs; fall back to plain book name when key is absent.
const BOOKMAKER_HOME: Record<string, string> = {
  // EU
  pinnacle:        'https://www.pinnacle.com',
  nordicbet:       'https://www.nordicbet.com',
  coolbet:         'https://www.coolbet.com',
  betsson:         'https://www.betsson.com',
  bwin:            'https://www.bwin.com',
  betclic:         'https://www.betclic.com',
  unibet_eu:       'https://www.unibet.eu',
  unibet_fr:       'https://www.unibet.fr',
  unibet_nl:       'https://www.unibet.nl',
  unibet_se:       'https://www.unibet.se',
  leovegas:        'https://www.leovegas.com',
  leovegas_se:     'https://www.leovegas.se',
  marathonbet:     'https://www.marathonbet.com',
  matchbook:       'https://www.matchbook.com',
  betfair_ex_eu:   'https://www.betfair.com',
  betano:          'https://www.betano.com',
  tonybet:         'https://www.tonybet.com',
  onexbet:         'https://www.1xbet.com',
  stoiximan:       'https://www.stoiximan.gr',
  livescore_bets:  'https://www.livescorebets.com',
  bethard:         'https://www.bethard.com',
  everygame:       'https://www.everygame.eu',
  '10bet':         'https://www.10bet.com',
  tipwin:          'https://www.tipwin.com',
  winamax_fr:      'https://www.winamax.fr',
  winamax_de:      'https://www.winamax.de',
  // UK
  bet365:          'https://www.bet365.com',
  smarkets:        'https://smarkets.com',
  betfair_ex_uk:   'https://www.betfair.com',
  betfair_sb_uk:   'https://www.betfair.com',
  williamhill:     'https://www.williamhill.com',
  paddypower:      'https://www.paddypower.com',
  skybet:          'https://www.skybet.com',
  ladbrokes_uk:    'https://www.ladbrokes.com',
  coral:           'https://www.coral.co.uk',
  unibet_uk:       'https://www.unibet.co.uk',
  unibet_gb:       'https://www.unibet.co.uk',
  betway:          'https://www.betway.com',
  boylesports:     'https://www.boylesports.com',
  betvictor:       'https://www.betvictor.com',
  spreadex:        'https://www.spreadex.com',
  betfred_uk:      'https://www.betfred.com',
  // US
  draftkings:      'https://sportsbook.draftkings.com',
  fanduel:         'https://sportsbook.fanduel.com',
  betmgm:          'https://sports.betmgm.com',
  caesars:         'https://www.caesarssportsbook.com',
  betrivers:       'https://www.betrivers.com',
  williamhill_us:  'https://www.williamhillsportsbook.com',
  pointsbet_us:    'https://www.pointsbet.com',
  bovada:          'https://www.bovada.lv',
  mybookieag:      'https://www.mybookie.ag',
  betonlineag:     'https://www.betonline.ag',
  betus:           'https://www.betus.com.pa',
  lowvig:          'https://www.lowvig.ag',
  gtbets:          'https://www.gtbets.eu',
  superbook:       'https://www.superbook.com',
  espnbet:         'https://www.espnbet.com',
  fanatics:        'https://www.fanatics.com/sportsbook',
  hard_rock_bet:   'https://www.hardrock.bet',
  bet365_us:       'https://www.bet365.com',
  betparx:         'https://www.betparx.com',
  fliff:           'https://www.getfliff.com',
  unibet_us:       'https://www.unibet.com/us',
  wynnbet:         'https://www.wynnbet.com',
};

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
  'Snapshot scan of EU/UK/US h2h odds via OddsAPI. NOT a live feed — data is from the last manual scan run. ' +
  'Surebets shown survive a minimum-bookmakers gate (≥4 books), a median outlier filter that removes ' +
  'suspiciously generous prices, and a plausibility cap (ROI > 6% → quarantine). ' +
  'Surebets may combine bookmakers from different jurisdictions (US vs EU/UK); these are flagged and may not be executable by a single account. ' +
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
        Each /odds request costs 3 credits (1 per region: EU + UK + US). The /sports discovery call is free.
        Scanner respects a {CREDIT_LOW_FLOOR}-credit safety floor and stops automatically.
      </p>
    </div>
  );
}

// ── Settlement panel (shared by both card types) ──────────────────────────────

type LegForPanel = Pick<ScannedEventLeg | SnapshotLeg, 'outcome' | 'bookmaker' | 'odd'> & {
  bookmakerId?: string;
  region?:      string;
};

function SettlementPanel({ settlement, legs }: { settlement: Settlement; legs: LegForPanel[] }) {
  return (
    <div className="border-t border-border/50 pt-3 space-y-3 mt-1">

      {/* Settlement rules */}
      <div className="space-y-1.5">
        <p className="font-mono text-[9px] uppercase tracking-widest text-text-muted">
          Settlement rules
        </p>
        <p className="font-mono text-[10px] text-text-muted/80 leading-relaxed">
          {settlement.basis}
        </p>
        {settlement.basisAmbiguous && (
          <div className="border border-amber-500/50 bg-amber-950/25 px-3 py-2.5 mt-1">
            <p className="font-mono text-[10px] text-amber-300 leading-relaxed">
              <span className="font-semibold">⚠ CROSS-SETTLEMENT RISK</span> — an arb that combines
              bookmakers settling on different bases is not a guaranteed hedge. Verify the exact
              settlement rule at each book before placing any bet.
            </p>
          </div>
        )}
      </div>

      {/* Per-leg book links */}
      <div className="space-y-1.5">
        <p className="font-mono text-[9px] uppercase tracking-widest text-text-muted">
          Books — verify current odds &amp; settlement rules before acting
        </p>
        <div className="border border-border/50 divide-y divide-border/30">
          {legs.map((leg, i) => {
            const reg  = (leg.region ?? 'unknown').toUpperCase();
            const url  = BOOKMAKER_HOME[leg.bookmakerId ?? ''] ?? null;
            return (
              <div key={i} className="grid grid-cols-4 items-center px-3 py-2 gap-2 font-mono text-[10px]">
                <span className="text-text-muted truncate pr-1">{leg.outcome}</span>
                <span className="truncate pr-1">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer"
                      className="text-accent hover:underline">
                      {leg.bookmaker}
                    </a>
                  ) : (
                    <span className="text-text-secondary">{leg.bookmaker}</span>
                  )}
                </span>
                <span>
                  <span className={`inline-block font-mono text-[9px] uppercase px-1 py-px border ${regionChipCls(reg)}`}>
                    {reg}
                  </span>
                </span>
                <span className="text-right text-accent tabular-nums">{leg.odd.toFixed(3)}</span>
              </div>
            );
          })}
        </div>
        <p className="font-mono text-[9px] text-text-muted/40 leading-relaxed">
          Links open bookmaker homepage only — no betslip pre-fill. Verify odds independently.
          No orders are placed by this tool.
        </p>
      </div>
    </div>
  );
}

// ── Opportunity card ──────────────────────────────────────────────────────────

function OpportunityCard({ opp }: { opp: SnapshotOpportunity }) {
  const [open, setOpen] = useState(false);
  const inMs      = new Date(opp.commenceTime).getTime() - Date.now();
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
            {opp.crossJurisdiction && (
              <span
                title="Legs span US and EU/UK bookmakers. Most bettors cannot hold accounts in both jurisdictions simultaneously — verify access before acting."
                className="font-mono text-[9px] uppercase tracking-wide border border-amber-500/50 bg-amber-950/40 text-amber-400 px-1 py-px"
              >
                CROSS-JURISDICTION
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
        <div className="grid grid-cols-5 px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-text-muted">
          <span>Outcome</span>
          <span>Bookmaker</span>
          <span>Region</span>
          <span className="text-right">Best odd</span>
          <span className="text-right">Stake %</span>
        </div>
        {opp.legs.map((leg, i) => {
          const reg = (leg.region ?? 'unknown').toUpperCase();
          return (
            <div key={i} className="grid grid-cols-5 px-3 py-2 font-mono text-[11px]">
              <span className="text-text-primary truncate pr-2">{leg.outcome}</span>
              <span className="text-text-secondary truncate pr-2">{leg.bookmaker}</span>
              <span>
                <span className={`inline-block font-mono text-[9px] uppercase px-1 py-px border ${regionChipCls(reg)}`}>
                  {reg}
                </span>
              </span>
              <span className="text-right text-accent tabular-nums">{leg.odd.toFixed(3)}</span>
              <span className="text-right text-positive tabular-nums">{leg.stakePct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>

      {/* Cross-jurisdiction warning */}
      {opp.crossJurisdiction && (
        <div className="border border-amber-500/40 bg-amber-950/20 px-3 py-2.5">
          <p className="font-mono text-[10px] text-amber-300/90 leading-relaxed">
            <span className="font-semibold">CROSS-JURISDICTION</span> — this surebet combines US bookmakers
            and EU/UK bookmakers. A single user may not be able to hold accounts in both jurisdictions.
            Verify you have access to all bookmakers listed before acting.
          </p>
        </div>
      )}

      {/* Footer note + expand toggle */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <p className="font-mono text-[9px] text-text-muted/50 leading-relaxed">
          Stake % is a preview hedge split for equalized payout. No orders placed by this tool.
          Verify both sides independently before acting — odds change in seconds.
          {opp.numBookmakers != null && ` ${opp.numBookmakers} books quoted this event.`}
        </p>
        {opp.settlement && (
          <button
            onClick={() => setOpen(v => !v)}
            className="shrink-0 font-mono text-[9px] text-text-muted/50 hover:text-text-muted transition-colors whitespace-nowrap"
            aria-expanded={open}
          >
            {open ? '▲ hide details' : '▼ settlement rules + book links'}
          </button>
        )}
      </div>

      {open && opp.settlement && (
        <SettlementPanel settlement={opp.settlement} legs={opp.legs} />
      )}
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

// ── Region chip helper (shared by OpportunityCard and ScannedEventCard) ───────

function regionChipCls(region: string) {
  const r = region.toUpperCase();
  if (r === 'US') return 'text-blue-400 border-blue-500/40 bg-blue-950/30';
  if (r === 'UK') return 'text-violet-400 border-violet-500/40 bg-violet-950/30';
  if (r === 'EU') return 'text-emerald-400 border-emerald-500/40 bg-emerald-950/30';
  return 'text-text-muted/50 border-border';
}

// ── Scanned event card (browsable list, NOT an arb opportunity) ───────────────

function ScannedEventCard({ ev }: { ev: ScannedEvent }) {
  const [open, setOpen] = useState(false);
  const isStarted  = new Date(ev.commenceTime).getTime() < Date.now();
  const isArb      = ev.marginPct < 0;
  const isNearMiss = !isArb && ev.marginPct < 1.5;

  return (
    <div className={`border p-4 space-y-3 ${isArb ? 'border-positive/40 bg-positive/5' : isNearMiss ? 'border-amber-600/40 bg-amber-950/10' : 'border-border bg-bg-panel'}`}>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-1">
            <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted">
              {ev.sportLabel}
            </span>
            <span className="font-mono text-[9px] text-text-muted/40">·</span>
            <span className="font-mono text-[9px] uppercase tracking-wide border border-border px-1 py-px text-text-muted">
              {ev.type}
            </span>
            <span className="font-mono text-[9px] text-text-muted/60">
              {ev.booksCount} books
            </span>
            {ev.outliersRemoved && (
              <span className="font-mono text-[9px] uppercase tracking-wide border border-border/40 text-text-muted/50 px-1 py-px">
                outlier-filtered
              </span>
            )}
            {isStarted && (
              <span className="font-mono text-[9px] uppercase border border-warning/40 text-warning px-1 py-px">
                STARTED
              </span>
            )}
          </div>
          <p className="font-mono text-sm font-semibold text-text-primary leading-tight">
            {ev.eventName}
          </p>
          <p className="font-mono text-[10px] text-text-muted mt-0.5">
            {isStarted
              ? 'Match already started'
              : `Starts in ${commenceRelative(ev.commenceTime)}`}
          </p>
        </div>

        {/* Margin display */}
        <div className="text-right shrink-0">
          <div className={`font-mono text-xl font-bold tabular-nums leading-none ${isArb ? 'text-positive' : isNearMiss ? 'text-amber-400' : 'text-text-secondary'}`}>
            {ev.marginPct.toFixed(2)}%
          </div>
          <div className="font-mono text-[9px] text-text-muted mt-0.5 whitespace-nowrap">
            {isArb
              ? <span className="text-positive/80">surebet · listed above</span>
              : isNearMiss
                ? <span className="text-amber-400/80">near-miss · watch</span>
                : 'overround — not an arb'}
          </div>
          <div className="font-mono text-[10px] text-text-muted/50 mt-0.5">
            impl. sum {(ev.impliedSum * 100).toFixed(2)}%
          </div>
        </div>
      </div>

      {/* Best-odds table */}
      <div className="border border-border divide-y divide-border">
        <div className="grid grid-cols-4 px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-text-muted">
          <span>Outcome</span>
          <span>Bookmaker</span>
          <span>Region</span>
          <span className="text-right">Best odd</span>
        </div>
        {ev.bestLegs.map((leg, i) => {
          const reg = (leg.region ?? 'unknown').toUpperCase();
          return (
            <div key={i} className="grid grid-cols-4 px-3 py-2 font-mono text-[11px]">
              <span className="text-text-primary truncate pr-2">{leg.outcome}</span>
              <span className="text-text-secondary truncate pr-2">{leg.bookmaker}</span>
              <span>
                <span className={`inline-block font-mono text-[9px] uppercase px-1 py-px border ${regionChipCls(reg)}`}>
                  {reg}
                </span>
              </span>
              <span className="text-right text-accent tabular-nums">{leg.odd.toFixed(3)}</span>
            </div>
          );
        })}
      </div>

      {/* Expand toggle */}
      {ev.settlement && (
        <div className="flex justify-end">
          <button
            onClick={() => setOpen(v => !v)}
            className="font-mono text-[9px] text-text-muted/50 hover:text-text-muted transition-colors"
            aria-expanded={open}
          >
            {open ? '▲ hide details' : '▼ settlement rules + book links'}
          </button>
        </div>
      )}

      {open && ev.settlement && (
        <SettlementPanel settlement={ev.settlement} legs={ev.bestLegs} />
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SportsSnapshotPage() {
  const [data,          setData]          = useState<SnapshotResponse | null>(null);
  const [lastFetch,     setLastFetch]     = useState<Date | null>(null);
  const [selectedSport, setSelectedSport] = useState<string | null>(null);

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

  // Initialize default tab to sport with most events, only once when data first loads
  useEffect(() => {
    if (selectedSport !== null) return;
    const sports = data?.summary?.sportsScanned ?? [];
    const withEvents = sports.filter((s: SportScanEntry) => s.eventCount > 0);
    if (!withEvents.length) return;
    const max = withEvents.reduce((b: SportScanEntry, s: SportScanEntry) => s.eventCount > b.eventCount ? s : b);
    setSelectedSport(max.key);
  }, [data, selectedSport]);

  const opps          = data?.opportunities  ?? [];
  const qItems        = data?.quarantine     ?? [];
  const scannedEvs    = data?.scannedEvents  ?? [];
  const summary       = data?.summary        ?? null;
  const lastUpdated   = data?.lastUpdated    ?? null;
  const isMissing     = data?.missing        ?? false;
  const effectiveSport = selectedSport ?? 'all';

  const filteredEvents = effectiveSport === 'all'
    ? scannedEvs
    : scannedEvs.filter(ev => ev.sport === effectiveSport);
  const sortedEvents = [...filteredEvents].sort((a, b) => a.marginPct - b.marginPct);

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
            CROSS-BOOKMAKER SUREBETS · EU/UK/US H2H · PERIODIC SNAPSHOT · NO ORDERS PLACED
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
            Each scan uses ~3 OddsAPI credits per sport (1 per region: EU+UK+US). Check credits.json before running.
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
              {(summary?.totalEvents ?? 0) > 0 && (
                <p className="font-mono text-[10px] text-text-muted/50 mt-2">
                  {summary!.sportsScanned.length} sport{summary!.sportsScanned.length > 1 ? 's' : ''} scanned ·
                  {summary!.totalEvents} events browsable below · outlier filter active · events with &lt;4 books excluded
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

          {/* ── Browse all scanned events ──────────────────────────────────── */}
          {scannedEvs.length > 0 && summary && (
            <div className="space-y-3 border-t border-border pt-5">

              {/* Section header */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
                  Browse scanned events — {summary.totalEvents} total
                </span>
                <span className="font-mono text-[9px] text-text-muted/50">
                  sorted by overround · closest to arb first
                </span>
              </div>

              {/* Sport tabs */}
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setSelectedSport('all')}
                  className={`font-mono text-[10px] px-2.5 py-1 border transition-colors duration-100 ${
                    effectiveSport === 'all'
                      ? 'border-accent text-accent bg-accent/10'
                      : 'border-border text-text-secondary hover:text-text-primary hover:border-border/80'
                  }`}
                >
                  All ({summary.totalEvents})
                </button>
                {summary.sportsScanned
                  .filter((s: SportScanEntry) => s.eventCount > 0)
                  .map((s: SportScanEntry) => (
                    <button
                      key={s.key}
                      onClick={() => setSelectedSport(s.key)}
                      className={`font-mono text-[10px] px-2.5 py-1 border transition-colors duration-100 ${
                        effectiveSport === s.key
                          ? 'border-accent text-accent bg-accent/10'
                          : 'border-border text-text-secondary hover:text-text-primary hover:border-border/80'
                      }`}
                    >
                      {s.label} ({s.eventCount})
                    </button>
                  ))}
              </div>

              {/* Scan metadata */}
              <p className="font-mono text-[9px] text-text-muted/50">
                regions: {(data.regions ?? []).join(', ')} · markets: h2h
                {data.ageMinutes != null && ` · snapshot ${data.ageMinutes}m old`}
                {lastFetch && ` · page fetched ${ago(lastFetch.toISOString())}`}
              </p>

              {/* Event list */}
              {sortedEvents.length === 0 ? (
                <p className="font-mono text-[11px] text-text-muted py-4 text-center">
                  No events for this sport.
                </p>
              ) : (
                <div className="space-y-3">
                  {sortedEvents.map((ev, i) => (
                    <ScannedEventCard key={i} ev={ev} />
                  ))}
                </div>
              )}
            </div>
          )}
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
          Data via The Odds API (EU/UK/US regions, h2h markets) · credit-safe scanner (floor: 30 remaining, 3 credits/sport) ·
          Surebets may combine bookmakers from different jurisdictions (US vs EU/UK); these are flagged and may not be executable by a single account. ·
          run manually with <code>node agents/agent12-sports.js</code>
        </p>
      </div>

    </div>
  );
}
