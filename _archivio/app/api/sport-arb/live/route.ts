import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier, REDACTION_MAP } from '@/lib/paid-gating';
import { assertRedacted } from '@/lib/guardian-suppress';
// SSOT shared with agents/agent33-sport-recorder.js — one fee model, one staleness rule.
// If this route computed its own math the dashboard could contradict the recorded file.
const {
  MAX_AGE_SEC, EXCHANGES, detectArbs, isLegLive, isDrawLeg, THREE_WAY_SPORTS,
} = require('@/lib/sport-arb-math');

/**
 * Self-defending guard so no fabricated-margin row from the history file (past OR future)
 * ever renders. Re-validates each recorded crossing against the CORRECTED SSOT logic rather
 * than trusting the row's stored is_live:
 *   - three-way / draw-leg rows (soccer summed as two-way) are dropped;
 *   - any leg not live under the per-venue gate (frozen or over-age book) drops the row.
 * Genuinely-live prediction crossings (Kalshi/Polymarket, age 0) pass unchanged.
 */
function isRenderableReal(rec: any): boolean {
  if (THREE_WAY_SPORTS.has(rec.sport)) return false;
  const legs = Array.isArray(rec.legs) ? rec.legs : [];
  if (!legs.length) return false;
  if (legs.some((l: any) => isDrawLeg(l))) return false;
  if (!legs.every((l: any) => isLegLive(l))) return false;
  // Both legs must resolve to the SAME game date. Pre-fix rows carry no game_date and cross-game
  // rows carry mismatched ones — either way they are not same-game verifiable, so they never render.
  const dates = legs.map((l: any) => l.game_date);
  if (dates.some((d: any) => d == null) || new Set(dates).size !== 1) return false;
  return true;
}

export const dynamic = 'force-dynamic';

const ROOT         = process.cwd();
const ARB_FILE     = path.join(ROOT, 'data', 'sport-arb-history.jsonl');
const PHANTOM_FILE = path.join(ROOT, 'data', 'sport-arb-phantoms.jsonl');
const RAW_DIR      = path.join(ROOT, 'data', 'sport-raw');
const AGENT12_FILE = path.join(ROOT, 'data', 'sports', 'opportunities.json');

// A crossing is only "live now" if it was observed in the last minute AND both of its
// legs were fresh when observed. Both conditions are required: a 5-minute-old record of
// a once-fresh crossing is history, not a tradable line.
const LIVE_WINDOW_MS = 60_000;
const TAIL_BYTES     = 512 * 1024;   // read only the end of append-only files

/** Read the last ~TAIL_BYTES of a JSONL file and parse whole lines. */
function tailJsonl(file: string, maxBytes = TAIL_BYTES): any[] {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    // If we started mid-file, drop the first (probably partial) line.
    const lines = text.split('\n').slice(start > 0 ? 1 : 0);
    const out: any[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* torn tail line */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function utcDay(d = new Date()) { return d.toISOString().slice(0, 10); }

const legType = (r: any) => (r.source_type === 'prediction' ? 'pred' : 'exch');

/**
 * windowSecs = how much VERIFIED-LIVE lifespan this quote has left, i.e. how long until
 * its oldest leg crosses the staleness line. It is a real measured quantity (MAX_AGE_SEC
 * minus the observed leg age), not a prediction about how long the market will disagree.
 * We cannot know the latter, so we do not claim it.
 */
function windowSecsFor(rec: any): number | null {
  const age = rec.maxLegAgeSec;
  if (age == null || !Number.isFinite(age)) return null;
  return Math.max(0, Math.round(MAX_AGE_SEC - age));
}

function shapeCrossing(rec: any) {
  const [h, a] = rec.legs;
  const netPct = rec.netProfitPct ?? null;
  const maxStake = rec.maxStake ?? null;
  return {
    id:      `${rec.event_key}|${h.source}|${a.source}|${rec.ts}`,
    match:   rec.home && rec.away ? `${rec.away} @ ${rec.home}` : rec.event_key,
    league:  rec.league ?? rec.sport ?? '—',
    // Game clock is NOT published by any of our sources. Rendering an invented minute
    // would be fabrication, so it stays null and the UI shows "—".
    clock:   null,
    legA: { side: h.team ?? h.outcome, venue: h.source, price: h.price ?? (h.odds ?? null), type: legType(h), ageSec: h.age_sec ?? null },
    legB: { side: a.team ?? a.outcome, venue: a.source, price: a.price ?? (a.odds ?? null), type: legType(a), ageSec: a.age_sec ?? null },
    netPct,
    netProfitEur: netPct != null && maxStake != null ? +((netPct / 100) * maxStake).toFixed(2) : null,
    maxStakeEur:  maxStake,
    bindingLeg:   rec.bindingLeg ?? null,
    sizeUnverifiable: rec.sizeUnverifiable !== false,
    windowSecs:   windowSecsFor(rec),
    jurisdictionTag: rec.jurisdiction?.tags?.[0] ?? '—',
    jurisdictionOpenableBoth: rec.jurisdiction?.openableBoth ?? null,
    executable:   !rec.sizeUnverifiable,
    netArbSum:    rec.netArbSum ?? null,
  };
}

/** Distinct events agent33 recorded in the last few minutes = what we're actually scanning. */
function liveGamesFromRecorder(now: number): number | null {
  const rows = tailJsonl(path.join(RAW_DIR, `${utcDay()}.jsonl`));
  if (!rows.length) return null;
  const keys = new Set<string>();
  for (const r of rows) if (now - (r.ts ?? 0) < 5 * 60_000) keys.add(r.event_key);
  return keys.size;
}

/**
 * FALLBACK — agent12's 3-hourly snapshot, run through the SAME detectArbs.
 *
 * This path exists so the tab is never blank-by-absence, but it is honest about what the
 * data is: agent12 writes one snapshot every 3h and stamps a single `lastUpdated`, so
 * every leg's age is hours, far beyond MAX_AGE_SEC. Those crossings are therefore
 * PHANTOMs by construction and are counted, never rendered as arbs. That is the correct
 * outcome, not a bug: a 3-hour-old book price is not a tradable live quote.
 */
function fallbackFromAgent12(now: number) {
  let data: any;
  try { data = JSON.parse(fs.readFileSync(AGENT12_FILE, 'utf8')); } catch { return null; }

  const stampMs = new Date(data.lastUpdated ?? 0).getTime();
  const ageSec  = Math.round((now - stampMs) / 1000);
  const events: any[] = Array.isArray(data.scannedEvents) ? data.scannedEvents : [];

  const rows: any[] = [];
  for (const ev of events) {
    const legs = Array.isArray(ev.bestLegs) ? ev.bestLegs : [];
    // Two-way moneyline only. A 3-way market (with Draw) cannot be covered by two legs,
    // so pairing its home/away legs would understate the true cost of the position.
    if (legs.length !== 2) continue;
    const [home, away] = legs;
    const base = {
      event_key: `${ev.sport}|${ev.eventName}`,
      sport: ev.sport, league: ev.sportLabel ?? ev.sport,
      home: legs[0]?.outcome ?? null, away: legs[1]?.outcome ?? null,
      market: 'moneyline', age_sec: ageSec, is_live: ageSec < MAX_AGE_SEC,
    };
    rows.push({ ...base, source: home.bookmakerId ?? home.bookmaker, outcome: 'home',
                team: home.outcome, odds: home.odd,
                source_type: EXCHANGES.has(home.bookmakerId ?? home.bookmaker) ? 'exchange' : 'book' });
    rows.push({ ...base, source: away.bookmakerId ?? away.bookmaker, outcome: 'away',
                team: away.outcome, odds: away.odd,
                source_type: EXCHANGES.has(away.bookmakerId ?? away.bookmaker) ? 'exchange' : 'book' });
  }

  const { real, phantom } = detectArbs(rows, now);
  const liveGames = events.filter(
    (e: any) => e.commenceTime && new Date(e.commenceTime).getTime() <= now
  ).length;

  return {
    real, phantom, liveGames,
    source: 'agent12-snapshot' as const,
    sourceAgeSec: ageSec,
    sourceNote:
      `agent12 snapshot is ${Math.round(ageSec / 60)} min old (3-hourly cadence); every leg is ` +
      `past the ${MAX_AGE_SEC}s live threshold, so its crossings are phantoms by construction`,
  };
}

export async function GET() {
  const now = Date.now();
  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);

  // ── primary: agent33's recorded live crossings ────────────────────────────
  const arbRows = tailJsonl(ARB_FILE);
  const liveRecs = arbRows.filter(
    // Re-validate against the corrected SSOT (not the row's stored is_live) so pre-fix
    // fabricated rows — three-way sums and frozen/over-age book legs — never render.
    (r) => now - (r.ts ?? 0) <= LIVE_WINDOW_MS && isRenderableReal(r)
  );

  const phantomRows = tailJsonl(PHANTOM_FILE);
  let phantomsBlocked = phantomRows.filter((r) => now - (r.ts ?? 0) <= 24 * 3600_000).length;

  let crossings = liveRecs.map(shapeCrossing);
  let liveGames = liveGamesFromRecorder(now);
  let source: string = 'agent33-recorder';
  let sourceNote: string | null = null;
  let sourceAgeSec: number | null = null;

  // ── fallback: only when the recorder has produced no live crossing ────────
  if (!crossings.length) {
    const fb = fallbackFromAgent12(now);
    if (fb) {
      // fb.real is empty by construction (all legs stale) — we do NOT render fb.phantom.
      crossings = fb.real.map(shapeCrossing);
      phantomsBlocked += fb.phantom.length;
      if (liveGames == null) liveGames = fb.liveGames;
      if (!crossings.length) {
        source = 'agent12-snapshot-fallback';
        sourceNote = fb.sourceNote;
        sourceAgeSec = fb.sourceAgeSec;
      }
    }
  }

  const body = redactForTier(
    {
      updatedAt: new Date(now).toISOString(),
      source,
      sourceNote,
      sourceAgeSec,
      liveGames: liveGames ?? 0,
      crossings,
      counts: {
        liveGames: liveGames ?? 0,
        crossings: crossings.length,
        phantomsBlocked,
      },
      feeModel: {
        exchangeCommissionPct: 2,
        kalshiTaker: '0.07*P*(1-P)',
        // Real per-market Polymarket taker fee from the live SSOT (lib/polymarket-fees.js):
        // (base_fee/20000)*(1-P), read from GET /fee-rate. No flat rate — "—" when base_fee is unknown.
        polymarketTaker: 'live per-market (base_fee/20000)*(1-P) — SSOT; "—" when unknown',
      },
      maxAgeSec: MAX_AGE_SEC,
      disclaimer:
        'Net is after all fees. Max stake is walkable book depth on the thinner leg only. ' +
        'Crossings with any leg older than 90s are phantoms and are never shown.',
      isPaid,
    },
    'sport-arb',
    isPaid,
  );

  if (!isPaid) assertRedacted(body, REDACTION_MAP['sport-arb'], { log: console.log });

  return NextResponse.json(body);
}
