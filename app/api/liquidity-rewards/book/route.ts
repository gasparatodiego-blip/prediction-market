import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const DATA_FILE = '/root/prediction-market/data/liquidity-rewards.json';
const CLOB_BASE = 'https://clob.polymarket.com';

async function fetchBook(tokenId: string): Promise<{ bids: {price:string;size:string}[]; asks: {price:string;size:string}[] } | null> {
  try {
    const r = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`, {
      next: { revalidate: 0 },
      headers: { 'Accept': 'application/json' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const conditionId = req.nextUrl.searchParams.get('conditionId');
  if (!conditionId) {
    return NextResponse.json({ error: 'conditionId required' }, { status: 400 });
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

  if (!tokenId) {
    return NextResponse.json({ error: 'tokenId missing from stored data', conditionId }, { status: 404 });
  }

  // Fetch YES book; NO book optional
  const [yesBook, noBook] = await Promise.all([
    fetchBook(tokenId),
    tokenIdNo ? fetchBook(tokenIdNo) : Promise.resolve(null),
  ]);

  if (!yesBook) {
    return NextResponse.json({ error: 'CLOB fetch failed', tokenId }, { status: 502 });
  }

  return NextResponse.json({
    conditionId,
    tokenId,
    tokenIdNo,
    yes: yesBook,
    no:  noBook,
    fetchedAt: new Date().toISOString(),
    source: 'Polymarket CLOB · read-only · no orders placed',
  });
}
