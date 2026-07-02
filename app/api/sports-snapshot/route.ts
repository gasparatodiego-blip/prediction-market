import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

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

export interface SnapshotLeg {
  outcome:      string;
  bookmaker:    string;
  bookmakerId?: string;
  odd:          number;
  stakePct:     number;
  region?:      string;
}

export interface SnapshotOpportunity {
  sport:              string;
  eventName:          string;
  commenceTime:       string;
  type:               '2way' | '3way';
  legs:               SnapshotLeg[];
  roiPct:             number;
  impliedSum:         number;
  outliersRemoved:    boolean;
  crossJurisdiction?: boolean;
  numBookmakers:      number;
  lastUpdated:        string;
  settlement?:        Settlement;
}

export interface SnapshotFlaggedArb extends SnapshotOpportunity {
  reasons: string[];  // e.g. 'unverified:betsson', 'exchange:smarkets', 'crossJurisdiction'
}

export interface SnapshotQuarantine {
  sport:        string;
  eventName:    string;
  commenceTime: string;
  type:         string;
  roiPct:       number;
  reason:       string;
}

export interface ScannedEventLeg {
  outcome:      string;
  bookmaker:    string;
  bookmakerId?: string;
  region:       string;
  odd:          number;
}

export interface ScannedEvent {
  sport:           string;
  sportLabel:      string;
  eventName:       string;
  commenceTime:    string;
  type:            '2way' | '3way';
  booksCount:      number;
  bestLegs:        ScannedEventLeg[];
  impliedSum:      number;
  marginPct:       number;
  outliersRemoved: boolean;
  settlement?:     Settlement;
  cashable?:       boolean;
  execReasons?:    string[];
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
  ok: false, missing: true, stale: true, ageMinutes: null,
  lastUpdated: null, creditsRemaining: null, creditsUsed: null,
  scanMode: 'snapshot', regions: [], sportsScanned: [],
  opportunities: [], flaggedArbs: [], quarantine: [], scannedEvents: [], summary: null,
};

export async function GET(): Promise<NextResponse<SnapshotResponse>> {
  try {
    const raw  = fs.readFileSync(FILE, 'utf-8');
    const data = JSON.parse(raw) as Omit<SnapshotResponse, 'ok' | 'missing' | 'stale' | 'ageMinutes'>;
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
      ageMinutes: Number.isFinite(age) ? Math.floor(age / 60_000) : null,
    }, 'sports-snapshot', isPaid);

    return NextResponse.json(body);
  } catch {
    return NextResponse.json(EMPTY);
  }
}
