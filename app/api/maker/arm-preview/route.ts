import { NextResponse } from 'next/server';
import fs from 'fs';
import { buildArmPreview } from '@/lib/maker/arm-preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/maker/arm-preview?perSide=<usd>&ttl=<sec>&cap=<usd> — "what you're about to arm": per-market real
// bid/ask/mid + size per side + total collateral + TTL, from the maker's OWN computed state (what it would
// post). Every number is real or "—"; if anything is unreadable, readable=false and the UI blocks arming.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const perSideSizeUsd = url.searchParams.get('perSide') != null ? Number(url.searchParams.get('perSide')) : null;
  const ttlSeconds = url.searchParams.get('ttl') != null ? Number(url.searchParams.get('ttl')) : null;
  const collateralCapUsd = url.searchParams.get('cap') != null ? Number(url.searchParams.get('cap')) : null;
  let makerState: unknown = null;
  try { makerState = JSON.parse(fs.readFileSync('/tmp/maker-state.json', 'utf8')); } catch { makerState = null; }
  const preview = buildArmPreview(makerState as Record<string, unknown>, { perSideSizeUsd, ttlSeconds, collateralCapUsd });
  return NextResponse.json(preview);
}
