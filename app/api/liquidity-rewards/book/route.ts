import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const DATA_FILE = '/root/prediction-market/data/liquidity-rewards.json';
const CLOB_BASE = 'https://clob.polymarket.com';

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

async function fetchBook(tokenId: string): Promise<{ bids: {price:string;size:string}[]; asks: {price:string;size:string}[] } | null> {
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

  // Serve from cache if fresh
  const cached = bookCache.get(conditionId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.data);
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

  const payload = {
    conditionId,
    tokenId,
    tokenIdNo,
    yes: yesBook,
    no:  noBook,
    fetchedAt: new Date().toISOString(),
    source: 'Polymarket CLOB · read-only · no orders placed',
  };
  bookCache.set(conditionId, { data: payload, ts: Date.now() });
  return NextResponse.json(payload);
}
