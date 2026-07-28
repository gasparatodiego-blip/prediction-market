import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';

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
const RUNNER = 'process.stdout.write(JSON.stringify(require("/root/prediction-market/lib/rewards/allocator").planFromCollection({ capital: Number(process.argv[1]) })))';
const RESULT_TTL_MS = 15 * 60_000;
const SPAWN_TIMEOUT_MS = 90_000; // planFromCollection scores the universe + builds per-tick fill curves
const MAX_BUFFER = 24 * 1024 * 1024;

const resultCache = new Map<string, { atMs: number; body: any }>();

function runAllocator(capital: number): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile('node', ['-e', RUNNER, String(capital)], { timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout) => {
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

  const bucket = String(Math.round(requested * 100) / 100);
  const cached = resultCache.get(bucket);
  if (cached && Date.now() - cached.atMs < RESULT_TTL_MS) return NextResponse.json({ ...cached.body, cached: true });

  try {
    const body = await runAllocator(requested);
    resultCache.set(bucket, { atMs: Date.now(), body });
    return NextResponse.json(body);
  } catch (e: any) {
    return NextResponse.json({ error: 'allocation failed: ' + (e?.message ?? 'unknown'), requested }, { status: 500 });
  }
}
