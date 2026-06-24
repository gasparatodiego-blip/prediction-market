import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

// Reads data/sports/opportunities.json produced by agent12-sports.js (snapshot scanner).
// Does NOT call OddsAPI — that would burn credits on every page load.
const FILE    = path.join(process.cwd(), 'data/sports/opportunities.json');
// On-demand snapshot; flag stale after 24h (one natural scan cycle)
const STALE_MS = 24 * 60 * 60_000;

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
}

export interface SnapshotQuarantine {
  sport:        string;
  eventName:    string;
  commenceTime: string;
  type:         string;
  roiPct:       number;
  reason:       string;
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
  quarantine:       SnapshotQuarantine[];
}

const EMPTY: SnapshotResponse = {
  ok: false, missing: true, stale: true, ageMinutes: null,
  lastUpdated: null, creditsRemaining: null, creditsUsed: null,
  scanMode: 'snapshot', regions: [], sportsScanned: [],
  opportunities: [], quarantine: [],
};

export async function GET(): Promise<NextResponse<SnapshotResponse>> {
  try {
    const raw  = fs.readFileSync(FILE, 'utf-8');
    const data = JSON.parse(raw) as Omit<SnapshotResponse, 'ok' | 'missing' | 'stale' | 'ageMinutes'>;
    const age  = data.lastUpdated
      ? Date.now() - new Date(data.lastUpdated).getTime()
      : Infinity;
    return NextResponse.json({
      ...data,
      ok:         true,
      missing:    false,
      stale:      age > STALE_MS,
      ageMinutes: Number.isFinite(age) ? Math.floor(age / 60_000) : null,
    });
  } catch {
    return NextResponse.json(EMPTY);
  }
}
