import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';
import { raggioBandaCents } from '../../../../../lib/banda-premiante';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/rewards/event/book?marketId=… — the LIVE half of the event terminal.
 *
 * The ladder comes from agent34's Polymarket CLOB **WebSocket** market-channel store (it writes
 * /tmp/clob-live-books.json every ~3s with the top of each book). This route does not poll the venue's
 * REST book on the happy path — it reads what the socket already knows.
 *
 * THE LIVENESS CONTRACT, which is the whole point of the route:
 *   live          — the socket file is fresh AND that market's book heard an event inside agent34's
 *                   staleness window. Only this state may be presented as a live book.
 *   rest-fallback — the socket is down/wedged/not subscribed to this market, so we take ONE REST
 *                   snapshot and hand it back labelled as a snapshot, with its own age.
 *   stale         — the socket file exists but this book is behind, and REST could not be reached
 *                   either. The last known ladder is returned WITH its real age in `ageMs`.
 * A frozen book is never returned as `live`. `ageMs` is always the age of the data being shown, not
 * the age of the request.
 */

const LIVE_FILE = '/tmp/clob-live-books.json';
const NORMALIZED_FILE = '/tmp/liquidity-rewards.json';
const CLOB_BASE = 'https://clob.polymarket.com';
// agent34 writes every 3s; past this the writer itself is down (not merely a quiet book).
const LIVE_FILE_STALE_MS = 20_000;
const REST_TIMEOUT_MS = 4_000;
const LADDER_LEVELS = 12;

type FeedState = 'live' | 'stale' | 'rest-fallback';
type Level = { price: number; size: number };
type Side = { bids: Level[]; asks: Level[]; bestBid: number | null; bestAsk: number | null };

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

/** Normalize agent34's persisted side into the ladder shape the terminal renders. */
function sideFromWs(s: any): Side | null {
  if (!s || !s.levels) return null;
  const lv = (a: unknown): Level[] =>
    (Array.isArray(a) ? a : [])
      .map((o: any) => ({ price: num(o?.price), size: num(o?.size) }))
      .filter((o): o is Level => o.price != null && o.size != null)
      .slice(0, LADDER_LEVELS);
  return { bids: lv(s.levels.bids), asks: lv(s.levels.asks), bestBid: num(s.bestBid), bestAsk: num(s.bestAsk) };
}

async function restBook(tokenId: string): Promise<Side | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REST_TIMEOUT_MS);
  try {
    const r = await fetch(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`, {
      signal: ctrl.signal, headers: { Accept: 'application/json' }, cache: 'no-store',
    });
    if (!r.ok) return null;
    const j = await r.json();
    const parse = (a: unknown, desc: boolean): Level[] =>
      (Array.isArray(a) ? a : [])
        .map((o: any) => ({ price: num(o?.price), size: num(o?.size) }))
        .filter((o): o is Level => o.price != null && o.size != null)
        // The REST book is returned ascending on both sides; the ladder wants best-first.
        .sort((x, y) => (desc ? y.price - x.price : x.price - y.price))
        .slice(0, LADDER_LEVELS);
    const bids = parse(j.bids, true);
    const asks = parse(j.asks, false);
    return { bids, asks, bestBid: bids[0]?.price ?? null, bestAsk: asks[0]?.price ?? null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const marketId = req.nextUrl.searchParams.get('marketId');
  if (!marketId) return NextResponse.json({ error: 'marketId required' }, { status: 400 });

  const session = await getServerSession(authOptions);
  const isPaid = await getIsPaid(session);

  // The feed row supplies the reward band's width and the token ids for the REST fallback.
  const snap = readJson(NORMALIZED_FILE);
  const feed = Array.isArray(snap?.markets) ? snap.markets.find((m: any) => m.marketId === marketId) : null;
  const maxSpreadCents = num(feed?.rewardScore?.maxSpreadCents) ?? num(feed?.maxSpread);
  const tokenId: string | null = feed?.tokenId ?? null;
  const tokenIdNo: string | null = feed?.tokenIdNo ?? null;

  const live = readJson(LIVE_FILE);
  const fileAgeMs = live?.generatedAt ? Date.now() - new Date(live.generatedAt).getTime() : null;
  const writerUp = fileAgeMs != null && fileAgeMs >= 0 && fileAgeMs <= LIVE_FILE_STALE_MS;
  const mk = writerUp ? live?.markets?.[marketId] ?? null : null;
  const wsLive = !!(mk && mk.live && mk.yes?.levels);

  let feedState: FeedState;
  let ageMs: number | null;
  let yes: Side | null = null;
  let no: Side | null = null;
  let scoringMid: number | null = null;
  let scoringMidSource: 'ws-live' | 'feed-snapshot' | null = null;
  let plainMid: number | null = null;
  let reason: string;

  if (wsLive) {
    feedState = 'live';
    ageMs = num(mk.ageMs);
    yes = sideFromWs(mk.yes);
    no = sideFromWs(mk.no);
    // Live scoring mid = the dust-filtered adjusted mid agent34 computes from THIS book with the
    // market's real min_incentive_size cutoff — the same definition agent24 stamps on the feed row.
    scoringMid = num(mk.mid);
    scoringMidSource = scoringMid != null ? 'ws-live' : null;
    plainMid = num(mk.plainMid);
    reason = 'socket CLOB attivo — book aggiornato dagli eventi, non da un sondaggio periodico';
  } else {
    // Socket unusable for this market. Take ONE REST snapshot and say plainly that is what it is.
    const [ry, rn] = await Promise.all([
      tokenId ? restBook(tokenId) : Promise.resolve(null),
      tokenIdNo ? restBook(tokenIdNo) : Promise.resolve(null),
    ]);
    if (ry) {
      feedState = 'rest-fallback';
      ageMs = 0;                                    // this snapshot was taken just now
      yes = ry; no = rn;
      plainMid = ry.bestBid != null && ry.bestAsk != null ? (ry.bestBid + ry.bestAsk) / 2 : null;
      // A REST snapshot carries no dust-filtered mid; fall back to the feed's scoring mid and SAY so,
      // rather than passing the plain (bid+ask)/2 off as the mid the reward band is centred on.
      scoringMid = num(feed?.rewardScore?.mid);
      scoringMidSource = scoringMid != null ? 'feed-snapshot' : null;
      reason = writerUp
        ? 'socket non sottoscritto a questo mercato — istantanea REST'
        : 'socket CLOB non disponibile — istantanea REST';
    } else if (mk?.yes?.levels) {
      // Neither path is fresh. Show the last book we actually have, aged, never as live.
      feedState = 'stale';
      ageMs = num(mk.ageMs) ?? fileAgeMs;
      yes = sideFromWs(mk.yes); no = sideFromWs(mk.no);
      scoringMid = num(mk.mid);
      scoringMidSource = scoringMid != null ? 'ws-live' : null;
      plainMid = num(mk.plainMid);
      reason = 'socket fermo e REST irraggiungibile — ultimo book noto, con la sua età';
    } else {
      feedState = 'stale';
      ageMs = null;
      reason = 'nessun book disponibile da questo mercato in questo momento';
    }
  }

  // The reward band, from the SAME half-width convention the validator uses (radius = maxSpread).
  const bandRadiusCents = maxSpreadCents != null ? raggioBandaCents(maxSpreadCents) : null;
  const bandLo = scoringMid != null && bandRadiusCents != null ? scoringMid - bandRadiusCents / 100 : null;
  const bandHi = scoringMid != null && bandRadiusCents != null ? scoringMid + bandRadiusCents / 100 : null;

  const payload = {
    marketId,
    feedState,
    ageMs,
    reason,
    writerUp,
    writerAgeMs: fileAgeMs,
    staleThresholdMs: LIVE_FILE_STALE_MS,
    yes,
    no,
    bestBid: yes?.bestBid ?? null,
    bestAsk: yes?.bestAsk ?? null,
    scoringMid,
    scoringMidSource,
    plainMid,
    maxSpreadCents,
    bandRadiusCents,
    bandLo,
    bandHi,
    ladderCap: LADDER_LEVELS,
    at: new Date().toISOString(),
    source: feedState === 'live'
      ? 'Polymarket CLOB market channel (WebSocket) · read-only · no orders placed'
      : 'Polymarket CLOB REST snapshot · read-only · no orders placed',
  };

  return NextResponse.json(redactForTier(payload, 'rewards-event-book', isPaid));
}
