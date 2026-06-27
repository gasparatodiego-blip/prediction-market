'use client';

import { useEffect, useState } from 'react';
import SectionHelp from '@/app/components/SectionHelp';
import Eyebrow from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import StatCard from '@/app/components/ui/StatCard';
import BlipRow from '@/app/components/ui/BlipRow';
import EdgeChip, { type EdgeChipVariant } from '@/app/components/ui/EdgeChip';
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

const POLL_MS          = 5 * 60_000;
const CREDIT_TOTAL     = 500;
const CREDIT_LOW_FLOOR = 60;

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

function sportEmoji(key: string): string {
  if (key.startsWith('soccer'))              return '⚽';
  if (key.startsWith('basketball'))          return '🏀';
  if (key.startsWith('americanfootball'))    return '🏈';
  if (key.startsWith('icehockey'))           return '🏒';
  if (key.startsWith('baseball'))            return '⚾';
  if (key.startsWith('tennis'))              return '🎾';
  return '🏆';
}

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

// ── Region chip ───────────────────────────────────────────────────────────────

function regionChipCls(region: string) {
  const r = region.toUpperCase();
  if (r === 'US') return 'text-violet border-violet/30 bg-violet-tint';
  if (r === 'UK') return 'text-gold border-gold/30 bg-gold-tint';
  if (r === 'EU') return 'text-mint-deep border-mint-deep/30 bg-mint-tint';
  return 'text-muted border-line bg-bg-soft';
}

// ── Disclaimer ────────────────────────────────────────────────────────────────

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
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill border border-gold/40 bg-gold-tint text-gold font-body font-medium text-[10px] hover:border-gold/60 transition-colors"
        aria-expanded={open}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-gold flex-shrink-0" aria-hidden />
        SNAPSHOT · preview only
        <span className="text-gold/60 ml-0.5">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <span className="absolute top-full right-0 z-20 mt-1.5 w-80 rounded-card border border-line bg-surface shadow-card px-4 py-3">
          <p className="font-body text-[11px] text-muted leading-relaxed">{DISCLAIMER_TEXT}</p>
          <button
            onClick={() => setOpen(false)}
            className="font-body text-[10px] text-muted/60 hover:text-muted mt-2"
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
      <div className="rounded-card shadow-card bg-surface px-5 py-4">
        <p className="font-body text-[11px] uppercase tracking-wide text-muted mb-1">OddsAPI monthly budget</p>
        <p className="font-body text-[12px] text-muted/60">Credit data not yet available — run a scan first.</p>
      </div>
    );
  }

  const pct    = Math.max(0, Math.min(100, (remaining / CREDIT_TOTAL) * 100));
  const isLow  = remaining < CREDIT_LOW_FLOOR;
  const barCls = isLow ? 'bg-gold' : pct > 40 ? 'bg-mint' : 'bg-mint/60';

  return (
    <div className={`rounded-card shadow-card bg-surface px-5 py-4 space-y-2${isLow ? ' border border-gold/30' : ''}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="font-body text-[11px] uppercase tracking-wide text-muted">OddsAPI monthly budget</p>
        <span className={`font-body text-[12px] font-medium ${isLow ? 'text-gold' : 'text-ink-2'}`}>
          {remaining} / {CREDIT_TOTAL} remaining{used != null ? ` · ${used} used` : ''}
          {isLow && <span className="ml-1.5 font-semibold">LOW</span>}
        </span>
      </div>
      <div className="h-1.5 bg-bg-soft rounded-full overflow-hidden">
        <div className={`h-full transition-all duration-300 rounded-full ${barCls}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="font-body text-[11px] text-muted/60 leading-relaxed">
        Each /odds request costs 3 credits (1 per region: EU + UK + US). The /sports discovery call is free.
        Scanner respects a {CREDIT_LOW_FLOOR}-credit safety floor and stops automatically.
      </p>
    </div>
  );
}

// ── Settlement panel ──────────────────────────────────────────────────────────

type LegForPanel = Pick<ScannedEventLeg | SnapshotLeg, 'outcome' | 'bookmaker' | 'odd'> & {
  bookmakerId?: string;
  region?:      string;
};

function SettlementPanel({ settlement, legs }: { settlement: Settlement; legs: LegForPanel[] }) {
  return (
    <div className="border-t border-line pt-4 space-y-4 mt-1">

      <div className="space-y-2">
        <p className="font-body text-[10px] uppercase tracking-widest text-muted">Settlement rules</p>
        <p className="font-body text-[12px] text-muted leading-relaxed">{settlement.basis}</p>
        {settlement.basisAmbiguous && (
          <div className="px-3 py-2.5 rounded-md bg-gold-tint border border-gold/25">
            <p className="font-body text-[12px] text-gold leading-relaxed">
              <span className="font-semibold">⚠ CROSS-SETTLEMENT RISK</span> — an arb that combines
              bookmakers settling on different bases is not a guaranteed hedge. Verify the exact
              settlement rule at each book before placing any bet.
            </p>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="font-body text-[10px] uppercase tracking-widest text-muted">
          Books — verify current odds &amp; settlement rules before acting
        </p>
        <div className="rounded-md border border-line overflow-hidden divide-y divide-line">
          {legs.map((leg, i) => {
            const reg = (leg.region ?? 'unknown').toUpperCase();
            const url = BOOKMAKER_HOME[leg.bookmakerId ?? ''] ?? null;
            return (
              <div key={i} className="grid grid-cols-4 items-center px-3 py-2.5 gap-2 font-body text-[12px] bg-surface">
                <span className="text-muted truncate">{leg.outcome}</span>
                <span className="truncate">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer"
                      className="text-mint-deep hover:underline">
                      {leg.bookmaker}
                    </a>
                  ) : (
                    <span className="text-ink-2">{leg.bookmaker}</span>
                  )}
                </span>
                <span>
                  <span className={`inline-flex items-center font-body text-[10px] uppercase px-1.5 py-0.5 rounded border ${regionChipCls(reg)}`}>
                    {reg}
                  </span>
                </span>
                <span className="text-right text-ink-2 tabular-nums font-medium">{leg.odd.toFixed(3)}</span>
              </div>
            );
          })}
        </div>
        <p className="font-body text-[11px] text-muted/60 leading-relaxed">
          Links open bookmaker homepage only — no betslip pre-fill. Verify odds independently.
          No orders are placed by this tool.
        </p>
      </div>
    </div>
  );
}

// ── Exec-reason formatter ─────────────────────────────────────────────────────

const EXEC_BOOK_NAMES: Record<string, string> = {
  onexbet:   '1xBet',
  gtbets:    'GTbets',
  nordicbet: 'NordicBet',
  betus:     'BetUS',
};

function formatExecReasons(reasons: string[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const r of reasons) {
    if (r === 'crossJurisdiction' && !seen.has(r)) {
      parts.push('cross-jurisdiction'); seen.add(r);
    } else if (r.startsWith('soft:') && !seen.has(r)) {
      const bid = r.slice(5);
      parts.push(EXEC_BOOK_NAMES[bid] ?? bid); seen.add(r);
    } else if (r.startsWith('exchange:') && !seen.has('exchange')) {
      parts.push('exchange leg'); seen.add('exchange');
    }
  }
  return parts.join(' · ');
}

// ── Opportunity card ──────────────────────────────────────────────────────────

function oppChipVariant(opp: SnapshotOpportunity): EdgeChipVariant {
  return opp.crossJurisdiction ? 'paper' : 'cashable';
}

function OpportunityCard({ opp }: { opp: SnapshotOpportunity }) {
  const [open, setOpen] = useState(false);
  const inMs      = new Date(opp.commenceTime).getTime() - Date.now();
  const isStarted = inMs < 0;
  const variant   = oppChipVariant(opp);

  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">

      <BlipRow
        icon={sportEmoji(opp.sport)}
        tileColor={variant === 'cashable' ? 'mint' : 'gold'}
        name={opp.eventName}
        sub={`${sportLabel(opp.sport)} · ${opp.type}${isStarted ? ' · started' : ` · in ${commenceRelative(opp.commenceTime)}`}`}
        chip={variant}
        value={`+${opp.roiPct.toFixed(2)}%`}
        unit="surebet ROI"
        valueTone={variant === 'cashable' ? 'up' : 'neutral'}
      />

      <div className="px-4 pb-4 space-y-3">

        {/* Badges + implied sum */}
        <div className="flex flex-wrap items-center gap-1.5">
          {opp.outliersRemoved && (
            <span
              title="Arb survived removal of outlier bookmaker prices — stronger trust signal."
              className="inline-flex items-center px-2 py-0.5 rounded-md bg-mint-tint border border-mint-deep/20 font-body text-[10px] text-mint-deep"
            >
              outlier-filtered
            </span>
          )}
          {isStarted && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-coral-tint border border-coral-ink/20 font-body text-[10px] text-coral-ink">
              STARTED
            </span>
          )}
          {opp.crossJurisdiction && (
            <span
              title="Legs span US and EU/UK bookmakers. Most bettors cannot hold accounts in both jurisdictions simultaneously."
              className="inline-flex items-center px-2 py-0.5 rounded-md bg-gold-tint border border-gold/25 font-body text-[10px] text-gold"
            >
              CROSS-JURISDICTION
            </span>
          )}
          <span className="font-body text-[11px] text-muted">
            impl. sum {(opp.impliedSum * 100).toFixed(2)}%
            {opp.numBookmakers != null && ` · ${opp.numBookmakers} books`}
          </span>
          {!isStarted && (
            <span className="font-body text-[11px] text-muted" title={absoluteTime(opp.commenceTime)}>
              · {absoluteTime(opp.commenceTime)}
            </span>
          )}
        </div>

        {/* Leg table */}
        <div className="rounded-md border border-line overflow-hidden">
          <div className="grid grid-cols-5 px-3 py-2 bg-bg-soft font-body text-[10px] uppercase tracking-wide text-muted">
            <span>Outcome</span>
            <span>Bookmaker</span>
            <span>Region</span>
            <span className="text-right">Best odd</span>
            <span className="text-right">Stake %</span>
          </div>
          {opp.legs.map((leg, i) => {
            const reg = (leg.region ?? 'unknown').toUpperCase();
            return (
              <div key={i} className="grid grid-cols-5 px-3 py-2.5 font-body text-[12px] border-t border-line">
                <span className="text-ink truncate pr-2">{leg.outcome}</span>
                <span className="text-ink-2 truncate pr-2">{leg.bookmaker}</span>
                <span>
                  <span className={`inline-flex items-center font-body text-[10px] uppercase px-1.5 py-0.5 rounded border ${regionChipCls(reg)}`}>
                    {reg}
                  </span>
                </span>
                <span className="text-right text-ink-2 tabular-nums font-medium">{leg.odd.toFixed(3)}</span>
                <span className="text-right text-mint-deep tabular-nums font-medium">{leg.stakePct.toFixed(1)}%</span>
              </div>
            );
          })}
        </div>

        {/* Cross-jurisdiction warning */}
        {opp.crossJurisdiction && (
          <div className="px-3 py-2.5 rounded-md bg-gold-tint border border-gold/25">
            <p className="font-body text-[12px] text-gold leading-relaxed">
              <span className="font-semibold">CROSS-JURISDICTION</span> — this surebet combines US bookmakers
              and EU/UK bookmakers. A single user may not be able to hold accounts in both jurisdictions.
              Verify you have access to all bookmakers listed before acting.
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <p className="font-body text-[11px] text-muted/70 leading-relaxed">
            Stake % is a preview hedge split for equalized payout. No orders placed by this tool.
            Verify both sides independently before acting — odds change in seconds.
          </p>
          {opp.settlement && (
            <button
              onClick={() => setOpen(v => !v)}
              className="shrink-0 font-body text-[11px] text-muted hover:text-ink-2 transition-colors whitespace-nowrap"
              aria-expanded={open}
            >
              {open ? '▲ hide details' : '▼ settlement + book links'}
            </button>
          )}
        </div>

        {open && opp.settlement && (
          <SettlementPanel settlement={opp.settlement} legs={opp.legs} />
        )}
      </div>
    </div>
  );
}

// ── Quarantine section ────────────────────────────────────────────────────────

function QuarantineSection({ items }: { items: SnapshotQuarantine[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-bg-soft/60 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="font-body text-[12px] text-muted">Quarantined — excluded, suspected bad data</span>
          <span className="px-2 py-0.5 rounded-pill bg-coral-tint text-coral-ink font-body font-medium text-[10px]">
            {items.length}
          </span>
        </div>
        <span className="font-body text-[11px] text-muted/60">{open ? '▲ close' : '▼ show'}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-line space-y-3 pt-4">
          <p className="font-body text-[12px] text-muted leading-relaxed">
            These events showed a surebet ROI above {6}% after outlier removal — implausibly high for
            real h2h markets. Most likely a data error (stale price, feed glitch, or bad scrape).
            Listed here for transparency only. Do NOT act on these.
          </p>
          <div className="rounded-md border border-line overflow-hidden divide-y divide-line">
            {items.map((q, i) => (
              <div
                key={i}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2.5 bg-surface font-body text-[12px]"
              >
                <span className="text-muted text-[10px]">{sportLabel(q.sport)}</span>
                <span className="text-ink-2">{q.eventName}</span>
                <span className="text-gold tabular-nums ml-auto">+{q.roiPct.toFixed(2)}%</span>
                <span className="text-muted text-[10px]">{q.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Scanned event card ────────────────────────────────────────────────────────

function scannedChipVariant(ev: ScannedEvent): EdgeChipVariant | undefined {
  const isNegative = ev.marginPct < 0;
  if (isNegative && ev.cashable === true) return 'cashable';
  if (isNegative && ev.cashable !== true) return 'paper';
  if (!isNegative && ev.marginPct < 1.5)  return 'signal';
  return undefined;
}

function ScannedEventCard({ ev }: { ev: ScannedEvent }) {
  const [open, setOpen] = useState(false);
  const isStarted  = new Date(ev.commenceTime).getTime() < Date.now();
  const isNegative = ev.marginPct < 0;
  const isCashable = isNegative && ev.cashable === true;
  const isPaperArb = isNegative && !isCashable;
  const isNearMiss = !isNegative && ev.marginPct < 1.5;

  const paperArbReason = isPaperArb ? formatExecReasons(ev.execReasons ?? []) : '';
  const chip      = scannedChipVariant(ev);
  const tileColor = isCashable ? 'mint' : isPaperArb ? 'gold' : isNearMiss ? 'violet' : 'mint';

  const unitLabel = isCashable
    ? 'cashable surebet'
    : isPaperArb
      ? `paper arb${paperArbReason ? ` · ${paperArbReason}` : ''}`
      : isNearMiss
        ? 'near-miss · watch'
        : 'overround';

  return (
    <div className="rounded-card border border-line bg-surface overflow-hidden">

      <BlipRow
        icon={sportEmoji(ev.sport)}
        tileColor={tileColor}
        name={ev.eventName}
        sub={`${ev.sportLabel} · ${ev.type} · ${ev.booksCount} books${isStarted ? ' · started' : ` · in ${commenceRelative(ev.commenceTime)}`}${ev.outliersRemoved ? ' · outlier-filtered' : ''}`}
        chip={chip}
        value={`${ev.marginPct.toFixed(2)}%`}
        unit={unitLabel}
        valueTone={isCashable ? 'up' : 'neutral'}
      />

      <div className="px-4 pb-4 space-y-3">

        {/* Best-odds table */}
        <div className="rounded-md border border-line overflow-hidden">
          <div className="grid grid-cols-4 px-3 py-2 bg-bg-soft font-body text-[10px] uppercase tracking-wide text-muted">
            <span>Outcome</span>
            <span>Bookmaker</span>
            <span>Region</span>
            <span className="text-right">Best odd</span>
          </div>
          {ev.bestLegs.map((leg, i) => {
            const reg = (leg.region ?? 'unknown').toUpperCase();
            return (
              <div key={i} className="grid grid-cols-4 px-3 py-2.5 font-body text-[12px] border-t border-line">
                <span className="text-ink truncate pr-2">{leg.outcome}</span>
                <span className="text-ink-2 truncate pr-2">{leg.bookmaker}</span>
                <span>
                  <span className={`inline-flex items-center font-body text-[10px] uppercase px-1.5 py-0.5 rounded border ${regionChipCls(reg)}`}>
                    {reg}
                  </span>
                </span>
                <span className="text-right text-ink-2 tabular-nums font-medium">{leg.odd.toFixed(3)}</span>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="font-body text-[11px] text-muted/60">
            impl. sum {(ev.impliedSum * 100).toFixed(2)}%
          </span>
          {ev.settlement && (
            <button
              onClick={() => setOpen(v => !v)}
              className="font-body text-[11px] text-muted hover:text-ink-2 transition-colors"
              aria-expanded={open}
            >
              {open ? '▲ hide details' : '▼ settlement rules + book links'}
            </button>
          )}
        </div>

        {open && ev.settlement && (
          <SettlementPanel settlement={ev.settlement} legs={ev.bestLegs} />
        )}
      </div>
    </div>
  );
}

// ── Stake limits & execution risk guide ──────────────────────────────────────

function StakeLimitsGuide() {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-bg-soft/60 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="font-body text-[12px] font-medium text-ink-2">Stake limits &amp; execution risk</span>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-gold-tint border border-gold/25 font-body font-medium text-[10px] text-gold uppercase tracking-wide">
            INDICATIVE
          </span>
        </div>
        <span className="font-body text-[11px] text-muted/60 shrink-0">{open ? '▲ close' : '▼ show'}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-line space-y-4 pt-4">
          <p className="font-body text-[12px] text-muted leading-relaxed">
            Bookmaker max-stake limits aren&apos;t available via our data feed and aren&apos;t
            fixed — books often lower an arber&apos;s personal limit after a few bets. Use the
            ranges below as rough guidance only and verify on each book.
          </p>

          {/* Indicative range table */}
          <div className="space-y-1.5">
            <p className="font-body text-[10px] uppercase tracking-widest text-muted/80">
              Typical max stake — indicative, varies by event/market/account
            </p>
            <div className="rounded-md border border-line overflow-hidden divide-y divide-line">
              <div className="grid grid-cols-[1fr_auto] items-start px-3 py-2.5 gap-3 bg-surface">
                <div>
                  <span className="font-body text-[12px] text-ink-2 font-medium">Sharp books / exchanges</span>
                  <span className="font-body text-[11px] text-muted ml-1.5">e.g. Pinnacle, Betfair</span>
                  <p className="font-body text-[11px] text-muted mt-0.5">Often €/$ thousands; rarely limit winners</p>
                </div>
                <span className="font-body text-[12px] font-semibold text-mint-deep shrink-0">High</span>
              </div>
              <div className="grid grid-cols-[1fr_auto] items-start px-3 py-2.5 gap-3 bg-surface">
                <div>
                  <span className="font-body text-[12px] text-ink-2 font-medium">Major regulated books</span>
                  <span className="font-body text-[11px] text-muted ml-1.5">bet365, William Hill, etc.</span>
                  <p className="font-body text-[11px] text-muted mt-0.5">Hundreds to low thousands; may limit consistent winners</p>
                </div>
                <span className="font-body text-[12px] font-semibold text-ink-2 shrink-0">Medium</span>
              </div>
              <div className="grid grid-cols-[1fr_auto] items-start px-3 py-2.5 gap-3 bg-surface">
                <div>
                  <span className="font-body text-[12px] text-ink-2 font-medium">Soft / promo-driven EU books</span>
                  <p className="font-body text-[11px] text-muted mt-0.5">Tens to low hundreds once flagged; fastest to restrict arbers</p>
                </div>
                <span className="font-body text-[12px] font-semibold text-gold shrink-0">Low</span>
              </div>
            </div>
            <p className="font-body text-[10px] text-muted/60">
              Ranges are illustrative only — actual limits vary by account history, jurisdiction, and event.
            </p>
          </div>

          {/* Execution risk */}
          <div className="space-y-2">
            <p className="font-body text-[10px] uppercase tracking-widest text-muted/80">Execution risk</p>
            <ul className="space-y-1">
              {[
                'Odds move in seconds — the second leg can shift before you fill it.',
                'Bet delay: many books hold a bet several seconds to validate; the other side may re-price meanwhile.',
                'Markets can suspend mid-placement, leaving you one-legged.',
                'Soft books may void or limit large / arb stakes after the fact.',
                'Always place the harder / most-likely-to-move leg first.',
              ].map((item, i) => (
                <li key={i} className="flex gap-1.5 font-body text-[12px] text-muted leading-relaxed">
                  <span className="text-muted/40 shrink-0 mt-px">·</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="font-body text-[11px] text-muted/60 border-t border-line pt-3 leading-relaxed">
            No orders placed by this tool. Verify both sides independently before acting.
          </p>
        </div>
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

  useEffect(() => {
    if (selectedSport !== null) return;
    const sports     = data?.summary?.sportsScanned ?? [];
    const withEvents = sports.filter((s: SportScanEntry) => s.eventCount > 0);
    if (!withEvents.length) return;
    const max = withEvents.reduce((b: SportScanEntry, s: SportScanEntry) => s.eventCount > b.eventCount ? s : b);
    setSelectedSport(max.key);
  }, [data, selectedSport]);

  const opps           = data?.opportunities  ?? [];
  const qItems         = data?.quarantine     ?? [];
  const scannedEvs     = data?.scannedEvents  ?? [];
  const summary        = data?.summary        ?? null;
  const lastUpdated    = data?.lastUpdated    ?? null;
  const isMissing      = data?.missing        ?? false;
  const effectiveSport = selectedSport ?? 'all';

  const filteredEvents = effectiveSport === 'all'
    ? scannedEvs
    : scannedEvs.filter(ev => ev.sport === effectiveSport);
  const sortedEvents = [...filteredEvents].sort((a, b) => a.marginPct - b.marginPct);

  const sportsWithEvents = summary?.sportsScanned.filter((s: SportScanEntry) => s.eventCount > 0) ?? [];

  return (
    <div className="max-w-[900px] mx-auto px-4 py-8 space-y-6">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Eyebrow className="mb-1">Sports Arbitrage</Eyebrow>
          <SectionHeading as="h1" className="text-2xl">
            Cross-Bookmaker Surebets
          </SectionHeading>
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill bg-gold-tint border border-gold/30 font-body font-medium text-[10px] text-gold">
              <span className="w-1.5 h-1.5 rounded-full bg-gold flex-shrink-0" aria-hidden />
              SNAPSHOT
            </span>
            {lastUpdated && (
              <span className="font-body text-[12px] text-muted" title={absoluteTime(lastUpdated)}>
                updated {relativeTime(lastUpdated)}
              </span>
            )}
            <span className="font-body text-[12px] text-muted">EU · UK · US · H2H · no orders placed</span>
          </div>
        </div>
        <DisclaimerChip />
      </div>

      {/* ── How to use ────────────────────────────────────────────────────── */}
      <SectionHelp section="sports" />

      {/* ── Missing file state ─────────────────────────────────────────────── */}
      {isMissing && (
        <div className="rounded-card shadow-card bg-surface px-6 py-12 text-center space-y-4">
          <p className="font-display font-semibold text-lg text-ink">No snapshot yet</p>
          <p className="font-body text-sm text-muted leading-relaxed">
            Run a scan to populate opportunities data:
          </p>
          <code className="font-mono text-[12px] text-mint-deep bg-bg-soft px-4 py-2 rounded-md block w-fit mx-auto border border-line">
            node agents/agent12-sports.js
          </code>
          <p className="font-body text-[11px] text-muted/60">
            Each scan uses ~3 OddsAPI credits per sport (1 per region: EU+UK+US). Check credits.json before running.
          </p>
        </div>
      )}

      {/* ── Data available ─────────────────────────────────────────────────── */}
      {!isMissing && data && (
        <>
          {/* Stale banner */}
          {data.stale && lastUpdated && (
            <div className="px-4 py-3 rounded-card border border-gold/30 bg-gold-tint font-body text-sm text-gold">
              Snapshot is over 24h old (last: {absoluteTime(lastUpdated)}).
              Run another scan when the monthly credit budget allows.
            </div>
          )}

          {/* Stat summary */}
          {summary && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <StatCard
                label="Events scanned"
                value={String(summary.totalEvents)}
                note={`${sportsWithEvents.length} sport${sportsWithEvents.length !== 1 ? 's' : ''}`}
              />
              <StatCard
                label="Surebets found"
                value={String(opps.length)}
                note={opps.length === 0 ? 'No confirmed arb right now' : 'Confirm before acting'}
              />
              <StatCard
                label="OddsAPI credits"
                value={data.creditsRemaining != null ? String(data.creditsRemaining) : '—'}
                note={`of ${CREDIT_TOTAL} remaining`}
                demoted={
                  data.creditsRemaining != null && data.creditsRemaining < CREDIT_LOW_FLOOR
                    ? 'LOW — approaching safety floor'
                    : undefined
                }
              />
            </div>
          )}

          {/* Credit meter */}
          <CreditMeter remaining={data.creditsRemaining} used={data.creditsUsed} />

          {/* Opportunities */}
          {opps.length === 0 ? (
            <div className="rounded-card shadow-card bg-surface px-6 py-12 text-center space-y-3">
              <p className="font-display font-semibold text-lg text-ink">
                No confirmed arb right now
              </p>
              <p className="font-body text-sm text-muted leading-relaxed max-w-md mx-auto">
                The scanned markets are efficiently priced. Genuine arb windows are rare and close in
                seconds — 0 surebets is honest, not a bug.
              </p>
              {(summary?.totalEvents ?? 0) > 0 && (
                <p className="font-body text-[12px] text-muted/70 mt-2">
                  {sportsWithEvents.length} sport{sportsWithEvents.length !== 1 ? 's' : ''} scanned ·{' '}
                  {summary!.totalEvents} events browsable below · outlier filter active · &lt;4 books excluded
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="font-body font-semibold text-sm text-ink-2">
                  {opps.length} surebet{opps.length !== 1 ? 's' : ''} — ranked by ROI
                </p>
                <span className="font-body text-[12px] text-muted">
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

          {/* ── Browse all scanned events ─────────────────────────────────── */}
          {scannedEvs.length > 0 && summary && (
            <div className="space-y-4 pt-2">

              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <Eyebrow className="mb-0.5">Browse scanned events</Eyebrow>
                  <p className="font-body text-[12px] text-muted">
                    {summary.totalEvents} total · sorted by overround, closest to arb first
                  </p>
                </div>
                <p className="font-body text-[11px] text-muted/60">
                  {(data.regions ?? []).join(' · ')} · h2h
                  {data.ageMinutes != null && ` · ${data.ageMinutes}m old`}
                  {lastFetch && ` · fetched ${ago(lastFetch.toISOString())}`}
                </p>
              </div>

              {/* Sport tabs */}
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setSelectedSport('all')}
                  className={`font-body text-[12px] px-3 py-1.5 rounded-button border transition-colors duration-100 ${
                    effectiveSport === 'all'
                      ? 'border-mint bg-mint-tint text-mint-deep'
                      : 'border-line text-muted hover:text-ink-2 hover:border-ink-2/30'
                  }`}
                >
                  All ({summary.totalEvents})
                </button>
                {sportsWithEvents.map((s: SportScanEntry) => (
                  <button
                    key={s.key}
                    onClick={() => setSelectedSport(s.key)}
                    className={`font-body text-[12px] px-3 py-1.5 rounded-button border transition-colors duration-100 ${
                      effectiveSport === s.key
                        ? 'border-mint bg-mint-tint text-mint-deep'
                        : 'border-line text-muted hover:text-ink-2 hover:border-ink-2/30'
                    }`}
                  >
                    {s.label} ({s.eventCount})
                  </button>
                ))}
              </div>

              {/* Event list */}
              {sortedEvents.length === 0 ? (
                <p className="font-body text-sm text-muted py-6 text-center">
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
        <div className="space-y-4 animate-pulse">
          <div className="h-20 rounded-card bg-bg-soft" />
          <div className="h-28 rounded-card bg-bg-soft" />
          <div className="h-36 rounded-card bg-bg-soft" />
        </div>
      )}

      {/* Stake limits & execution risk */}
      <StakeLimitsGuide />

      {/* Footer */}
      <div className="border-t border-line pt-5 space-y-1.5">
        <p className="font-body text-[11px] text-muted/70 leading-relaxed">
          Snapshot-mode scanner only — does NOT place orders or access any bookmaker account.
          Stake percentages are illustrative hedge splits for equalized payout on any bankroll size.
          Bookmakers limit arb accounts; always verify odds manually before acting.
        </p>
        <p className="font-body text-[11px] text-muted/50 leading-relaxed">
          Data via The Odds API (EU/UK/US regions, h2h markets) · credit-safe scanner (floor: 30 remaining, 3 credits/sport) ·
          Surebets may combine bookmakers from different jurisdictions; cross-jurisdiction pairs are flagged and may not be executable. ·
          run manually with{' '}
          <code className="font-mono text-[10px] text-ink-2">node agents/agent12-sports.js</code>
        </p>
      </div>

    </div>
  );
}
