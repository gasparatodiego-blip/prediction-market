import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { runBulkAllocation } from '@/lib/maker/bulk-allocate';
import { diagnoseExposure } from '@/lib/maker/manual-reset';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/maker/manual/bulk-allocate — place every row of an allocation plan, in sequence.
 *
 * It is a loop over the SAME placeManualOrder every hand order uses: no second placement path, no extra
 * venue surface, and every order lands under the same watcher management afterwards (mid chase, band
 * ceiling, GTD renewal, reconciliation).
 *
 * WHAT IT ADDS is the CUMULATIVE cap. Ten orders each individually under the per-order cap can still add
 * up past the account's open-notional ceiling, and the per-order gate cannot see that. So the run tracks
 * its own running total — starting from exposure ALREADY open, not from zero — and STOPS cleanly the
 * moment the next row would cross it, rather than attempting it and letting a gate refuse mid-sequence.
 * It stops instead of skipping ahead to a smaller row that would still fit: silently reordering an
 * allocation makes it a different allocation from the one that was confirmed.
 *
 * `preview: true` runs the whole sequence WITHOUT placing anything — same cap arithmetic, same stop
 * point, nothing sent. That is what backs the confirmation summary.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */
const rowSchema = z.object({
  marketId: z.string().trim().min(1).max(200),
  book: z.enum(['yes', 'no']),
  side: z.enum(['BUY', 'SELL']).optional(),
  price: z.number().finite().gt(0).lt(1),
  size: z.number().finite().gt(0).max(100_000),
  title: z.string().max(300).optional(),
});
const bodySchema = z.object({
  rows: z.array(rowSchema).min(1).max(50),
  preview: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, gate: 'invalid-body', detail: parsed.error.flatten() }, { status: 400 });
  }

  try {
    // The running total starts from what is ALREADY open, read from the same source the cap gate uses.
    const diag = diagnoseExposure({});
    const res = await runBulkAllocation(
      { rows: parsed.data.rows, dryRunOnly: parsed.data.preview === true },
      { openNotionalUsd: diag.readable ? (diag.openNotionalUsd || 0) : 0 },
    );
    // A run that stopped on the cap is a 200 carrying the full story: the request was well formed and the
    // system answered it. The panel renders which rows are live and which never happened.
    return NextResponse.json({ ...res, openBefore: diag.openNotionalUsd });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message, at: new Date().toISOString(), results: [], reason: 'la sequenza è fallita prima di completarsi' },
      { status: 500 },
    );
  }
}
