import { NextResponse } from 'next/server';
import fs from 'fs';

const SPORTS_FILE = '/tmp/sports-odds.json';

export interface SportsMeta {
  key:    string;
  label:  string;
  emoji:  string;
  region: string;
}

export interface BestOdd {
  name:       string;
  price:      number;
  bookmaker:  string;
}

export interface ArbBet {
  outcome:    string;
  bookmaker:  string;
  bookmakerId: string;
  odds:       number;
  stake:      number;
}

export interface SportsMarket {
  id:             string;
  sport:          string;
  sportLabel:     string;
  sportEmoji:     string;
  homeTeam:       string;
  awayTeam:       string;
  commenceTime:   string;
  bookmakers:     string[];
  bestOdds:       BestOdd[];
  impliedSum:     number;
  arbOpportunity: boolean;
  arbPct:         number;
  arbBets:        ArbBet[];
}

export interface SportsResponse {
  sports:           string[];
  sportsMeta:       SportsMeta[];
  markets:          SportsMarket[];
  arbOpportunities: SportsMarket[];
  totalEvents:      number;
  totalArb:         number;
  fetchedAt:        number;
  dataAge:          number;
}

export async function GET() {
  try {
    const raw  = fs.readFileSync(SPORTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    const dataAge = Date.now() - (data.fetchedAt ?? 0);
    return NextResponse.json({ ...data, dataAge } as SportsResponse);
  } catch {
    return NextResponse.json({
      sports: [], sportsMeta: [], markets: [], arbOpportunities: [],
      totalEvents: 0, totalArb: 0,
      fetchedAt: 0, dataAge: 999_999_999,
    } as SportsResponse);
  }
}
