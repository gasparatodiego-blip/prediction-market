import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const SPORTS_FILE = '/tmp/sports-odds.json';
const STALE_MS    = 2 * 60 * 60_000;  // agent polls every 45 min; stale after 2h

export interface ArbLeg {
  outcome:     string;
  bookmaker:   string;
  bookmakerId: string;
  odds:        number;
  impliedProb: number;
  stake:       number;
  payout:      number;
}

export interface SportsArb {
  eventId:      string;
  sport:        string;
  homeTeam:     string;
  awayTeam:     string;
  commenceTime: string;
  legs:         ArbLeg[];
  impliedSum:   number;
  grossMargin:  number;
  netMargin:    number;
  fetchedAt:    number;
  oddsAgeMs:    number;
  isStale:      boolean;
}

export interface SportsResponse {
  ok:               boolean;
  isStale:          boolean;
  ageMinutes:       number | null;
  updatedAt:        string | null;
  creditsRemaining: number | null;
  paused:           boolean;
  sportsChecked:    string[];
  totalEvents:      number;
  totalArb:         number;
  arbOpportunities: SportsArb[];
}

export async function GET(): Promise<NextResponse<SportsResponse>> {
  const empty: SportsResponse = {
    ok: false, isStale: true, ageMinutes: null, updatedAt: null,
    creditsRemaining: null, paused: false,
    sportsChecked: [], totalEvents: 0, totalArb: 0, arbOpportunities: [],
  };

  try {
    const raw  = fs.readFileSync(SPORTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    const age  = Date.now() - (data.fetchedAt ?? 0);

    return NextResponse.json({
      ok:               true,
      isStale:          age > STALE_MS,
      ageMinutes:       Math.floor(age / 60_000),
      updatedAt:        data.updatedAt ?? null,
      creditsRemaining: data.creditsRemaining ?? null,
      paused:           data.paused ?? false,
      sportsChecked:    data.sportsChecked ?? [],
      totalEvents:      data.totalEvents ?? 0,
      totalArb:         data.totalArb ?? 0,
      arbOpportunities: data.arbOpportunities ?? [],
    });
  } catch {
    return NextResponse.json(empty);
  }
}
