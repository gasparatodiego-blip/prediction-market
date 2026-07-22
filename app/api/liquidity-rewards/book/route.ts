import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

export const dynamic = 'force-dynamic';

const DATA_FILE = '/root/prediction-market/data/liquidity-rewards.json';
const LIVE_FILE = '/tmp/clob-live-books.json';
const CLOB_BASE = 'https://clob.polymarket.com';

// agent34 writes the live-book snapshot every ~3s. If the file is older than this
// the WS agent is down/wedged → we are on the coarse 15-min REST path and say so.
// (Operational liveness threshold, derived from the 3s write cadence — NOT a
// return/edge figure. Flagged for Diego's sign-off.)
const LIVE_FILE_STALE_MS = 20_000;

type FeedState = 'live' | 'stale' | 'rest-fallback';

// Read agent34's live band for this market. Returns an honest feed state:
//   'live'         — WS book fresh; band centered on the dust-filtered ADJUSTED mid
//   'stale'        — market present but its book is stale → treat as REST-coarse
//   'rest-fallback'— no live file / agent down / market not covered → REST only
function readLiveBand(conditionId: string): {
  feedState: FeedState; feedAgeMs: number | null; adjustedMid: number | null;
  plainMid: number | null; bandRadiusC: number | null; midAdjVsPlainC: number | null;
} {
  const off = { feedState: 'rest-fallback' as FeedState, feedAgeMs: null, adjustedMid: null, plainMid: null, bandRadiusC: null, midAdjVsPlainC: null };
  try {
    const live = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf-8'));
    const fileAge = Date.now() - new Date(live.generatedAt).getTime();
    if (!(fileAge >= 0) || fileAge > LIVE_FILE_STALE_MS) return off; // agent down → REST fallback
    const m = live.markets?.[conditionId];
    if (!m) return off;                                              // market not subscribed → REST fallback
    return {
      feedState: m.live ? 'live' : 'stale',
      feedAgeMs: typeof m.ageMs === 'number' ? m.ageMs : fileAge,
      adjustedMid: m.mid ?? null,
      plainMid: m.plainMid ?? null,
      bandRadiusC: m.bandRadiusC ?? null,
      midAdjVsPlainC: m.midAdjVsPlainC ?? null,
    };
  } catch {
    return off; // no file yet / parse error → honest REST fallback
  }
}

// 2-second in-memory cache keyed by conditionId to absorb repeat/simultaneous opens
const bookCache = new Map<string, { data: object; ts: number }>();
const CACHE_TTL_MS = 2_000;

async function clobFetch(url: string, timeoutMs = 3_500): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBook(tokenId: string): Promise<{ bids: {price:string;size:string}[]; asks: {price:string;size:string}[]; tick_size?: number | string; min_order_size?: number | string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await clobFetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      // retry once on abort/network error, then give up
    }
  }
  return null;
}

// Resolve token IDs from CLOB /markets/{conditionId} when stored data is stale
async function resolveTokenIds(conditionId: string): Promise<{ tokenId: string | null; tokenIdNo: string | null }> {
  try {
    const r = await clobFetch(`${CLOB_BASE}/markets/${conditionId}`);
    if (!r.ok) return { tokenId: null, tokenIdNo: null };
    const data = await r.json();
    const tokens = data.tokens as Array<{ token_id: string; outcome: string }> | undefined;
    if (!tokens?.length) return { tokenId: null, tokenIdNo: null };
    const yes = tokens.find(t => t.outcome === 'Yes');
    const no  = tokens.find(t => t.outcome === 'No');
    return {
      tokenId:   yes?.token_id ?? null,
      tokenIdNo: no?.token_id  ?? null,
    };
  } catch {
    return { tokenId: null, tokenIdNo: null };
  }
}

export async function GET(req: NextRequest) {
  const conditionId = req.nextUrl.searchParams.get('conditionId');
  if (!conditionId) {
    return NextResponse.json({ error: 'conditionId required' }, { status: 400 });
  }

  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);

  // Serve from cache if fresh
  const cached = bookCache.get(conditionId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(redactForTier(cached.data, 'liquidity-rewards-book', isPaid));
  }

  // Look up token IDs from stored data
  let tokenId: string | null = null;
  let tokenIdNo: string | null = null;
  let marketMeta: Record<string, unknown> | null = null;

  try {
    const raw  = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const mkt  = (data.markets as Record<string, unknown>[]).find(
      (m) => m.conditionId === conditionId,
    );
    if (!mkt) {
      return NextResponse.json({ error: 'market not found', conditionId }, { status: 404 });
    }
    tokenId   = (mkt.tokenId   as string) || null;
    tokenIdNo = (mkt.tokenIdNo as string) || null;
    marketMeta = mkt;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `data read error: ${msg}` }, { status: 500 });
  }

  // Fallback: resolve token IDs from CLOB when stored data is stale/missing them
  if (!tokenId) {
    const resolved = await resolveTokenIds(conditionId);
    tokenId   = resolved.tokenId;
    tokenIdNo = resolved.tokenIdNo;
  }

  if (!tokenId) {
    return NextResponse.json(
      { error: 'order book temporarily unavailable for this market', conditionId },
      { status: 503 },
    );
  }

  // Fetch YES book; NO book optional
  const [yesBook, noBook] = await Promise.all([
    fetchBook(tokenId),
    tokenIdNo ? fetchBook(tokenIdNo) : Promise.resolve(null),
  ]);

  if (!yesBook) {
    return NextResponse.json({ error: 'CLOB fetch failed', tokenId }, { status: 502 });
  }

  // Real per-market min price increment, straight from the same CLOB /book payload
  // (Polymarket returns tick_size on the book response — e.g. "0.01" = 1¢, "0.001" = 0.1¢).
  // NB: the CLOB serves tick_size as a STRING, so coerce before use. The UI clamps its order
  // controls to this so it never offers a price the book rejects.
  const parseTick = (v: number | string | undefined): number | null => {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const tickSize = parseTick(yesBook.tick_size) ?? parseTick(noBook?.tick_size);

  // Live band from agent34's WS feed (honest: labelled live / stale / rest-fallback).
  // The ladders above stay REST (on-demand depth); the band CENTER upgrades to the
  // live dust-filtered adjusted mid when the feed is fresh. Reward math unchanged.
  const live = readLiveBand(conditionId);

  const payload = {
    conditionId,
    tokenId,
    tokenIdNo,
    yes: yesBook,
    no:  noBook,
    tickSize,
    live,   // { feedState, feedAgeMs, adjustedMid, plainMid, bandRadiusC, midAdjVsPlainC }
    fetchedAt: new Date().toISOString(),
    source: live.feedState === 'live'
      ? 'Polymarket CLOB · live WS band + REST depth · read-only · no orders placed'
      : 'Polymarket CLOB · REST (WS feed unavailable — coarse) · read-only · no orders placed',
  };
  bookCache.set(conditionId, { data: payload, ts: Date.now() });
  return NextResponse.json(redactForTier(payload, 'liquidity-rewards-book', isPaid));
}
