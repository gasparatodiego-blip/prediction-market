import { NextResponse } from 'next/server';
import { buildCryptoBody, DETAIL_FIELDS } from '@/lib/crypto-payload';

export const dynamic = 'force-dynamic';

export type { FuturesCoin, SlipPoint, SpreadItem } from '@/lib/spread-compute';

/**
 * LIST payload. The full body is built by the shared pipeline (including redaction and the
 * redaction backstop), then the heavy per-row detail fields are stripped — the client
 * downloads 1678 rows but renders at most 25 (6 on first paint), so shipping their detail
 * is pure waste. /api/crypto/detail serves those fields for the rows actually rendered.
 *
 * Slimming happens strictly AFTER assertRedacted, so gating still runs against the full
 * shape (REDACTION_MAP covers spreads[].slipCurve[].*) and cannot be hollowed out here.
 */
export async function GET() {
  const { body } = await buildCryptoBody();

  if (Array.isArray(body?.spreads)) {
    for (const r of body.spreads) {
      // capCase()/capRank() — which drive the SORT, hence which rows render — need only
      // "is slipCurve present and non-empty". Ship the count so ordering is bit-identical
      // to the pre-split payload without shipping the curve.
      r.slipCurveN = Array.isArray(r.slipCurve) ? r.slipCurve.length : 0;
      for (const f of DETAIL_FIELDS) delete r[f];
    }
  }

  return NextResponse.json(body);
}
