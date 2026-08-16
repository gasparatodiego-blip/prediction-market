import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

export const dynamic = 'force-dynamic';

const KALSHI_BASE  = 'https://api.elections.kalshi.com/trade-api/v2';
const CACHE_TTL_MS = 2_000;

const cache = new Map<string, { data: object; ts: number }>();

async function fetchBook(ticker: string): Promise<object | null> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const r = await fetch(`${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}/orderbook`, {
      signal:  ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get('ticker');
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 });

  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);

  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return NextResponse.json(redactForTier(hit.data, 'kalshi-rewards-book', isPaid));
  }

  const raw = await fetchBook(ticker);
  if (!raw) {
    return NextResponse.json(
      { error: 'Kalshi order book unavailable — API unreachable or ticker not found' },
      { status: 502 },
    );
  }

  const payload = { ...(raw as object), ticker, fetchedAt: new Date().toISOString() };
  cache.set(ticker, { data: payload, ts: Date.now() });
  return NextResponse.json(redactForTier(payload, 'kalshi-rewards-book', isPaid));
}
