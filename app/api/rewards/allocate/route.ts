import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
// THE POSITION CEILING IS DERIVED HERE, AND ONLY HERE. The planner has just computed how much capital
// each market gets; the fill strategy needs exactly that number as its per-side inventory ceiling. It is
// recorded as a derived snapshot — there is no control anywhere that lets an operator type it.
import { writeAllocatedCapital } from '@/lib/maker/allocated-capital';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/rewards/allocate?capital=N — the capital allocation plan (with per-market offset data).
 *
 * READ-ONLY / PLAN-ONLY. It spawns a SEPARATE plain-node process running lib/rewards/allocator's
 * planFromCollection() over the recently collected mid-history + trade tape at the operator's capital. The
 * child reads no key, signs nothing, and constructs NO order object; this handler only spawns it, caches the
 * JSON, and echoes the requested capital VERBATIM (never rewritten/clamped). Out-of-process both dodges the
 * allocator's dynamic-require chain in webpack and frees the heavy journal memory when the child exits.
 *
 * The plan carries, per row, everything the CLIENT needs to recompute its own offset locally (no refetch):
 * the per-tick snapped bid/ask + fills + cost, the band width, the S=1 gross, and the structural fill score.
 *
 * Honest-engine: gross per market; net "—" unless a fill was observed; coverage the true ~25% of the live
 * collectable universe, not the manifest's over-100%.
 */

// Inline runner — plain node, no webpack. Prints the plan JSON for the requested capital.
// argv[2] carries the auto-optimise flag: with it on, the allocator also applies the resolution-horizon
// test (lib/rewards/horizon) before the knapsack. OFF is the shipped path, byte-for-byte.
const RUNNER = 'process.stdout.write(JSON.stringify(require("/root/prediction-market/lib/rewards/allocator").planFromCollection({ capital: Number(process.argv[1]), horizonFilter: process.argv[2] === "1" })))';
const RESULT_TTL_MS = 180_000; // 3 min — the plan auto-refreshes at this cadence; recompute costs ~19s, so a fresh plan every 3 min is live-enough while the per-row data age ticks locally every 15s
const SPAWN_TIMEOUT_MS = 90_000; // planFromCollection scores the universe + builds per-tick fill curves
const MAX_BUFFER = 24 * 1024 * 1024;

const resultCache = new Map<string, { atMs: number; body: any }>();

function runAllocator(capital: number, horizonFilter: boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile('node', ['-e', RUNNER, String(capital), horizonFilter ? '1' : '0'], { timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e: any) { reject(new Error('allocator output not JSON: ' + e.message)); }
    });
  });
}

const EMPTY = (requested: number) => ({
  generatedAt: new Date().toISOString(), requested, capital: 0, unit: 0, offsetCents: 1,
  window: null, staleFrac: 0,
  coverage: { coveredMarketCount: null, manifestUniverse: null, truePct: null, partial: true, headerLines: [], trueNote: '' },
  observed: { totalFills: 0, filledMarkets: 0, windowHours: 0 },
  fillScore: { auc: null, ci95: null, nFilled: 0, nUnfilled: 0, note: '' },
  offsetFrontier: [],
  rows: [], totals: { capital: 0, unallocated: 0, grossPerDay: 0, netPerDay: null, count: 0 },
  annualisedGross: { pct: null, capped: false, cap: 200, label: 'lordo (adverse selection misurata a parte), run-rate, non garantito' },
  frontier: [],
});

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('capital');
  const requested = raw == null || raw === '' ? 0 : Number(raw);
  if (!Number.isFinite(requested) || requested < 0) {
    return NextResponse.json({ error: 'capital must be a non-negative number', requested: raw }, { status: 400 });
  }
  if (requested === 0) return NextResponse.json(EMPTY(0)); // default/empty capital → no allocation, no spawn

  // AUTO-OPTIMISE — read-only, like everything else on this route. It widens nothing (the universe was
  // always the whole reward board) and writes nothing; it only turns on the resolution-horizon test and
  // makes the allocator return its candidate ledger reasons under that rule.
  const horizonFilter = req.nextUrl.searchParams.get('auto') === '1';

  const bucket = `${Math.round(requested * 100) / 100}:${horizonFilter ? 'auto' : 'base'}`;
  const cached = resultCache.get(bucket);
  if (cached && Date.now() - cached.atMs < RESULT_TTL_MS) return NextResponse.json({ ...cached.body, cached: true });

  try {
    const body = await runAllocator(requested, horizonFilter);
    resultCache.set(bucket, { atMs: Date.now(), body });
    // Record the derived ceiling. Best-effort: a failure here must never cost the operator their plan,
    // and a missing snapshot fails CLOSED downstream (no ceiling ⇒ no new exposure), not open.
    try {
      writeAllocatedCapital({
        rows: (body?.rows ?? []).map((r: any) => ({ marketId: r.marketId, capital: r.capital })),
        capital: body?.capital ?? null,
      });
    } catch { /* the plan still stands; the strategy simply has no ceiling to read */ }
    return NextResponse.json(body);
  } catch (e: any) {
    return NextResponse.json({ error: 'allocation failed: ' + (e?.message ?? 'unknown'), requested }, { status: 500 });
  }
}
