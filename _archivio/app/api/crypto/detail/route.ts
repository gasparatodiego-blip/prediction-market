import { NextResponse } from 'next/server';
import { buildCryptoBody, DETAIL_FIELDS, rowKey } from '@/lib/crypto-payload';

export const dynamic = 'force-dynamic';

const MAX_KEYS = 64;   // the card view can render at most 25; this is a generous bound

/**
 * Per-row DETAIL, batched. Returns exactly the fields the list route strips, for the rows
 * the client is actually rendering — so nothing a user could see before disappears.
 *
 * It calls the SAME buildCryptoBody() as the list route, so the values are byte-identical
 * to what the pre-split payload carried and the free-tier redaction is the same code, not
 * a reimplementation of it. A derived-edge field cannot leak here unless it also leaks on
 * the list route.
 *
 *   GET /api/crypto/detail?keys=BTC|lighter|apex,ETH|okx|bybit
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('keys') || '';
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean).slice(0, MAX_KEYS);
  if (keys.length === 0) return NextResponse.json({ detail: {} });

  const wanted = new Set(keys);
  const { body } = await buildCryptoBody();

  const detail: Record<string, Record<string, unknown>> = {};
  for (const r of (Array.isArray(body?.spreads) ? body.spreads : [])) {
    const k = rowKey(r);
    if (!wanted.has(k)) continue;
    const picked: Record<string, unknown> = {};
    for (const f of DETAIL_FIELDS) if (f in r) picked[f] = r[f];
    detail[k] = picked;
  }

  // Keys with no matching row simply do not appear — the client renders those rows without
  // detail rather than inventing one.
  return NextResponse.json({ detail });
}
