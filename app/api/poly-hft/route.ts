import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const SIGNALS_FILE = '/tmp/poly-hft-signals.json';
const LOG_FILE     = '/tmp/poly-hft-log.json';
const STALE_MS     = 90_000; // treat data older than 90 s as stale

export interface HFTSignal {
  conditionId:      string;
  slug:             string;
  title:            string;
  coin:             string;
  duration:         string;
  sourceConfidence: 'canonical' | 'proxy';
  windowStart:      number;
  windowEnd:        number;
  timeRemainingSec: number;
  openPrice:        number | null;
  currentPrice:     number | null;
  priceMoveP:       number | null;
  fairP:            number;
  polyPUp:          number;
  divergence:       number;
  flaggedSide:      'Up' | 'Down';
  edgeP:            number;
  bestBid:          number | null;
  bestAsk:          number | null;
  capacityUsdc:     number | null;
  status:           'live';
  flaggedAt:        string;
  disclaimer:       string;
}

export interface HFTStats {
  totalFlagged:  number;
  totalResolved: number;
  totalWon:      number;
  hitRatePct:    number | null;
  bySourceConfidence: {
    canonical: { flagged: number; resolved: number; won: number; hitRatePct: number | null };
    proxy:     { flagged: number; resolved: number; won: number; hitRatePct: number | null };
  };
  note: string;
}

export interface HFTResponse {
  agentStatus:      'running' | 'stale' | 'offline';
  updatedAt:        string | null;
  liveSignals:      HFTSignal[];
  monitoredMarkets: any[];
  stats:            HFTStats | null;
  logEntries:       any[];
}

export async function GET() {
  try {
    let payload: any = { liveSignals: [], monitoredMarkets: [], stats: null, updatedAt: null };
    let agentStatus: 'running' | 'stale' | 'offline' = 'offline';

    if (fs.existsSync(SIGNALS_FILE)) {
      const mtime = fs.statSync(SIGNALS_FILE).mtimeMs;
      const age   = Date.now() - mtime;
      payload     = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'));
      agentStatus = age < STALE_MS ? 'running' : 'stale';
    }

    let logEntries: any[] = [];
    if (fs.existsSync(LOG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
      // Return last 100 entries, newest first
      logEntries = [...raw].reverse().slice(0, 100);
    }

    const resp: HFTResponse = {
      agentStatus,
      updatedAt:        payload.updatedAt ?? null,
      liveSignals:      payload.liveSignals      ?? [],
      monitoredMarkets: payload.monitoredMarkets ?? [],
      stats:            payload.stats            ?? null,
      logEntries,
    };

    return NextResponse.json(resp);
  } catch (e) {
    return NextResponse.json(
      { agentStatus: 'offline', error: String(e), liveSignals: [], monitoredMarkets: [], stats: null, logEntries: [] },
      { status: 500 }
    );
  }
}
