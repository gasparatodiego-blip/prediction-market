import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { runOperatorReset, diagnoseExposure } from '@/lib/maker/manual-reset';
import { killStatus } from '@/lib/safety/kill-switch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/maker/manual/reset — "RIPRISTINA": bring the manual lane back to a provably clean, re-armed state
 * after a KILL, and prove it from BOTH sources rather than from the cancel command's own say-so.
 *
 * GET  → the diagnosis only. READ-ONLY: it cancels nothing, clears nothing, writes nothing. It answers
 *        "where does the cap gate's open exposure actually come from" — split into confirmed positions
 *        versus sent orders no reconciliation ever resolved. Used to explain a refusal without acting on it.
 *
 * POST → the full sequence. Every step carries its own evidence in the response, because the whole reason
 *        this endpoint exists is that "the orders table is empty" was accepted as proof once and was not
 *        proof at all:
 *          a. read the resting orders FROM THE VENUE across every managed market (marketId omitted, so the
 *             account's whole open-order list is swept — an order on a market the panel stopped tracking
 *             cannot hide);
 *          b. diagnose the venue-vs-cap-gate discrepancy in numbers;
 *          c. cancel the panel's own residual orders (CANCEL-ONLY adapter — it holds no signing key and
 *             structurally cannot place); orders not attributable to this panel are left alone;
 *          d. reconcile the sent-order ledger against venue truth, WITH the /trades cross-check that makes
 *             a "not filled" conclusion honest — never a fabricated resolution;
 *          e. clear the kill switch (durable, audited, the same writer the KILL button's counterpart uses);
 *          f. re-read the VENUE and re-read the CAP GATE, and only report success if BOTH say zero;
 *          g. write the whole sequence to the audit as one `operator-reset` event.
 *
 * IT ADDS NO AUTHORITY AND CANNOT PLACE. The only mutating venue call reachable from here is a cancel.
 * Clearing the kill switch re-enables nothing by itself: arming, caps, manual ownership, venue rules and
 * validateOrder all still govern the next order exactly as before.
 *
 * DELIBERATELY NOT TOUCHED: the automatic engine's arming console (agent35). That is a separate two-step
 * control on its own tab and this endpoint neither reads nor writes it.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */
export async function GET() {
  try {
    // The kill state travels with the diagnosis so the RIPRISTINA button has ONE source for both "may I
    // act" and "what would I be fixing". Two polls could disagree for a few seconds and leave the button
    // enabled against a kill that is already clear.
    const k = killStatus({});
    return NextResponse.json({
      at: new Date().toISOString(),
      kill: {
        killed: k.effectivelyKilled,
        readable: k.readable,
        reason: (k.global && k.global.reason) || null,
        by: (k.global && k.global.by) || null,
        at: (k.global && k.global.at) || null,
      },
      diagnosis: diagnoseExposure({}),
    });
  } catch (e) {
    return NextResponse.json({ at: new Date().toISOString(), error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: { reason?: unknown } = {};
  try { body = await req.json(); } catch { /* body is optional */ }
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;

  try {
    const res = await runOperatorReset({ by: 'operator · pannello ordini manuali', reason });
    // A sequence that ran but could not prove a clean state is a 200 carrying `ok:false` and the reason:
    // the request was well formed and the system answered it honestly. Reserve non-2xx for a real failure,
    // so the panel can always render WHICH step fell short instead of an opaque HTTP error.
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json(
      { ok: false, at: new Date().toISOString(), error: (e as Error).message, steps: [], reason: 'la sequenza di ripristino è fallita prima di completarsi — nessuno stato è stato dimostrato' },
      { status: 500 },
    );
  }
}
