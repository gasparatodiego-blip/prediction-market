import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Proxies Polymarket's PUBLIC, keyless CLOB price-history endpoint so the trader
// detail page can lazily draw a token's real price line under a position's fills.
// Server-side (avoids browser CORS); no key, no cost. Honest degrade: on any
// failure we return { ok:false, history:[] } and the page shows the fill table
// without a chart — never a fabricated line.
const CLOB = 'https://clob.polymarket.com/prices-history';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token || !/^\d+$/.test(token)) {
    return NextResponse.json({ ok: false, history: [], error: 'bad token' }, { status: 400 });
  }
  const startTs = req.nextUrl.searchParams.get('startTs');
  const endTs   = req.nextUrl.searchParams.get('endTs');
  const fidelity = req.nextUrl.searchParams.get('fidelity') || '10'; // minutes/bucket

  const qs = new URLSearchParams({ market: token, fidelity });
  if (startTs && /^\d+$/.test(startTs)) qs.set('startTs', startTs);
  if (endTs && /^\d+$/.test(endTs))     qs.set('endTs', endTs);
  else qs.set('interval', 'max');   // whole life of the market when no explicit window

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10_000);
    const r = await fetch(`${CLOB}?${qs.toString()}`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(to);
    if (!r.ok) return NextResponse.json({ ok: false, history: [], error: `clob ${r.status}` });
    const j: any = await r.json();
    const history = Array.isArray(j?.history)
      ? j.history.filter((p: any) => p && Number.isFinite(p.t) && Number.isFinite(p.p))
                 .map((p: any) => ({ t: p.t, p: p.p }))
      : [];
    return NextResponse.json({ ok: true, token, history }, {
      headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=120' },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, history: [], error: e?.message || 'fetch failed' });
  }
}
