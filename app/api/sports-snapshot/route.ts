import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier, REDACTION_MAP } from '@/lib/paid-gating';
import { assertRedacted } from '@/lib/guardian-suppress';

export const dynamic = 'force-dynamic';

// Reads data/sports/opportunities.json produced by agent12-sports.js (snapshot scanner).
// Does NOT call OddsAPI — that would burn credits on every page load.
const FILE    = path.join(process.cwd(), 'data/sports/opportunities.json');
// On-demand snapshot; flag stale after 24h (one natural scan cycle)
const STALE_MS = 24 * 60 * 60_000;

export interface Settlement {
  basis:               string;
  isKnockout:          boolean;
  basisAmbiguous:      boolean;
  crossSettlementRisk: boolean;
}

// odd/stakePct/roiPct/impliedSum/marginPct: null on free tier (server-side
// redaction, lib/paid-gating.ts) — see REDACTION_MAP['sports-snapshot'].
export interface SnapshotLeg {
  outcome:      string;
  bookmaker:    string;
  bookmakerId?: string;
  odd:          number | null;
  stakePct:     number | null;
  region?:      string;
}

export interface SnapshotOpportunity {
  sport:              string;
  eventName:          string;
  commenceTime:       string;
  type:               '2way' | '3way';
  legs:               SnapshotLeg[];
  roiPct:             number | null;
  impliedSum:         number | null;
  outliersRemoved:    boolean;
  crossJurisdiction?: boolean;
  numBookmakers:      number;
  lastUpdated:        string;
  settlement?:        Settlement;
  sharpReference?:    SharpReference | null;
  edgeVsSharp?:       EdgeVsSharp;
  kind?:              EventKind;
  arbProfitPct?:      number | null;
  arbLegs?:           ArbLeg[] | null;
  arbReason?:         string | null;
}

export interface SnapshotFlaggedArb extends SnapshotOpportunity {
  reasons: string[];  // e.g. 'unverified:betsson', 'exchange:smarkets', 'crossJurisdiction'
}

export interface SnapshotQuarantine {
  sport:        string;
  eventName:    string;
  commenceTime: string;
  type:         string;
  roiPct:       number | null;
  reason:       string;
}

export interface ScannedEventLeg {
  outcome:      string;
  bookmaker:    string;
  bookmakerId?: string;
  region:       string;
  odd:          number | null;
}

// Sharp reference (Pinnacle) + edge-vs-sharp, persisted per event by agent12
// (commit 8749e84). GATED for free tier (commit 4bc8121): raw[].odd, overround,
// marginPct, noVig[].fairProb, noVig[].fairOdds, edgeVsSharp.edgePct/rawEdgePct/
// softOdd/fairOdds/reason → null. Structure, book names, status, outcome names,
// sharpReference.present stay visible as teaser.
export interface SharpRawLeg  { outcome: string; odd: number | null; }
export interface SharpNoVigLeg { outcome: string; fairProb: number | null; fairOdds: number | null; }
export interface SharpReference {
  present:    boolean;
  book?:      string;                 // 'pinnacle'
  reason?:    string;                 // when !present: 'pinnacle_not_quoted' | 'devig_failed'
  raw:        SharpRawLeg[]  | null;   // .odd null on free tier
  overround:  number | null;
  marginPct:  number | null;
  noVig:      SharpNoVigLeg[] | null;  // fairProb/fairOdds null on free tier
}
// True arbitrage (arbSum < 1) per event, computed by agent12. kind is public;
// arbProfitPct + arbLegs[].odd/stakePct are GATED for free tier (fail-closed).
export type EventKind = 'cashable' | 'signal';
export interface ArbLeg {
  outcome:     string;
  bookmaker:   string;
  bookmakerId: string;
  region:      string;
  odd:         number | null;   // gated
  stakePct:    number | null;   // gated
}

export type EdgeVsSharpStatus =
  | 'signal' | 'none' | 'no_sharp_reference' | 'no_comparable_outcome' | 'suppressed_outlier';
export interface EdgeVsSharp {
  status:               EdgeVsSharpStatus;
  edgePct:              number | null;   // gated
  outcome?:             string;
  softBook?:            string;
  softBookId?:          string;
  softClass?:           'exchange' | 'unverified' | 'sharp';
  softOdd?:             number | null;   // gated
  fairOdds?:            number | null;   // gated
  cashable?:            boolean;
  reason?:              string | null;   // suppressed_outlier reason — GATED (embeds raw %)
  rawEdgePct?:          number | null;   // gated
  excludedNearCertain?: number;
}

export interface ScannedEvent {
  sport:           string;
  sportLabel:      string;
  eventName:       string;
  commenceTime:    string;
  type:            '2way' | '3way';
  booksCount:      number;
  bestLegs:        ScannedEventLeg[];
  impliedSum:      number | null;
  marginPct:       number | null;
  outliersRemoved: boolean;
  settlement?:     Settlement;
  cashable?:       boolean;
  execReasons?:    string[];
  sharpReference?: SharpReference | null;
  edgeVsSharp?:    EdgeVsSharp;
  kind?:           EventKind;          // 'cashable' (real arbSum<1 arb) | 'signal'
  arbProfitPct?:   number | null;      // guaranteed profit fraction (1−arbSum) — gated
  arbLegs?:        ArbLeg[] | null;    // covering legs — cashable only; odd/stakePct gated
  arbReason?:      string | null;      // why a would-be arb is not cashable (enum, public)
}

export interface SportScanEntry {
  key:        string;
  label:      string;
  eventCount: number;
}

export interface ScanSummary {
  sportsScanned: SportScanEntry[];
  totalEvents:   number;
}

export interface SnapshotResponse {
  ok:               boolean;
  missing:          boolean;
  stale:            boolean;
  isPaid:           boolean;
  ageMinutes:       number | null;
  lastUpdated:      string | null;
  creditsRemaining: number | null;
  creditsUsed:      number | null;
  scanMode:         string;
  regions:          string[];
  sportsScanned:    string[];
  opportunities:    SnapshotOpportunity[];
  flaggedArbs:      SnapshotFlaggedArb[];
  quarantine:       SnapshotQuarantine[];
  scannedEvents:    ScannedEvent[];
  summary:          ScanSummary | null;
}

const EMPTY: SnapshotResponse = {
  ok: false, missing: true, stale: true, isPaid: false, ageMinutes: null,
  lastUpdated: null, creditsRemaining: null, creditsUsed: null,
  scanMode: 'snapshot', regions: [], sportsScanned: [],
  opportunities: [], flaggedArbs: [], quarantine: [], scannedEvents: [], summary: null,
};

export async function GET(): Promise<NextResponse<SnapshotResponse>> {
  try {
    const raw  = fs.readFileSync(FILE, 'utf-8');
    const data = JSON.parse(raw) as Omit<SnapshotResponse, 'ok' | 'missing' | 'stale' | 'isPaid' | 'ageMinutes'>;
    const age  = data.lastUpdated
      ? Date.now() - new Date(data.lastUpdated).getTime()
      : Infinity;

    const session = await getServerSession(authOptions);
    const isPaid  = await getIsPaid(session);
    const body    = redactForTier({
      ...data,
      ok:         true,
      missing:    false,
      stale:      age > STALE_MS,
      isPaid,
      ageMinutes: Number.isFinite(age) ? Math.floor(age / 60_000) : null,
    }, 'sports-snapshot', isPaid);

    // Guardian H (rules 31–33): backstop the redaction — null + CRITICAL any leaked
    // roi/odds field on the free tier (display-only; never fabricates). No-op for paid.
    if (!isPaid) assertRedacted(body, REDACTION_MAP['sports-snapshot'], { log: console.log });

    return NextResponse.json(body);
  } catch {
    return NextResponse.json(EMPTY);
  }
}
