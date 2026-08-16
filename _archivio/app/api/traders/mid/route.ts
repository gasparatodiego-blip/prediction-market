import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Proxies Polymarket's PUBLIC, keyless CLOB midpoint endpoint so the trader detail
// page can mark an OPEN position to the current mid in real time (light per-open
// poll every ~7s). Server-side (avoids browser CORS); no key, no cost. HONEST
// degrade: on any failure we return { ok:false, mid:null } and the page keeps the
// last value and marks it stale — it never fabricates a fresh mid. The recomputed
// number stays labelled "unrealized · mark-to-mid" and is gated exactly like the
// feed's P&L (the caller only polls when the value is already visible / paid).
const CLOB = 'https://clob.polymarket.com/midpoint';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token || !/^\d+$/.test(token)) {
    return NextResponse.json({ ok: false, mid: null, error: 'bad token' }, { status: 400 });
  }

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8_000);
    const r = await fetch(`${CLOB}?token_id=${token}`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(to);
    if (!r.ok) return NextResponse.json({ ok: false, mid: null, error: `clob ${r.status}` });
    const j: any = await r.json();
    const mid = j?.mid != null ? Number(j.mid) : NaN;
    if (!Number.isFinite(mid)) return NextResponse.json({ ok: false, mid: null, error: 'no mid' });
    return NextResponse.json({ ok: true, token, mid }, {
      headers: { 'Cache-Control': 's-maxage=3, stale-while-revalidate=10' },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, mid: null, error: e?.message || 'fetch failed' });
  }
}
