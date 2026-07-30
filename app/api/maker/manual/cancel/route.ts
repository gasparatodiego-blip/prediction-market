import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { cancelManualOrder } from '@/lib/maker/manual-order';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/maker/manual/cancel — cancel ONE resting order by id.
 *
 * Runs through the CANCEL-ONLY adapter (address-only signer: no signing key, structurally cannot place),
 * the same primitive the KILL button and the dead-man watchdog use. So this endpoint can stop an order
 * and can never start one — and cancelling never decrypts the signing key.
 *
 * DELIBERATELY NOT GATED ON THE KILL SWITCH OR ON MANUAL OWNERSHIP. A cancel can only REDUCE exposure,
 * and the moment the operator most needs it is precisely when the system is killed or when a market has
 * already been handed back to the engine. Refusing a cancel is never the safe direction — that reading is
 * the same one POST /api/maker/cancel and the KILL button already make.
 *
 * Idempotent: an order that is already gone reports `noop:true` with ok:true, not a failure. Without
 * stored credentials the adapter is dry-run and reports `simulated:true` — an honest "nothing was sent",
 * never a claimed cancellation.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */

const bodySchema = z.object({
  orderId: z.string().trim().min(1).max(200),
  marketId: z.string().trim().min(1).max(200).optional(),
});

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, gate: 'invalid-body', detail: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const res = await cancelManualOrder(parsed.data);
    return NextResponse.json(res, { status: res.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, orderId: parsed.data.orderId, error: (e as Error).message, at: new Date().toISOString() },
      { status: 500 },
    );
  }
}
