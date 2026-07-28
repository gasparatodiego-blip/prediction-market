import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/rewards/allocate?capital=N — the capital allocation plan.
 *
 * READ-ONLY / PLAN-ONLY. It spawns scripts/rewards-replay/allocate-json.js in a SEPARATE node process,
 * which runs the SHARED knapsack allocator (lib/rewards/allocator — the exact module the $5,000 backtest
 * uses) over the recently collected mid-history + trade tape at the operator's capital and prints the plan.
 * The child reads no key, signs nothing, and constructs NO order object; this handler only spawns it, caches
 * the JSON, and echoes the requested capital VERBATIM (never rewritten/clamped). Running it out-of-process
 * also frees the heavy journal memory as soon as the child exits.
 *
 * Honest-engine: gross per market; net "—" unless a fill was observed; coverage the true ~20-25% of the
 * live collectable universe, not the manifest's over-100%.
 */

const SCRIPT = '/root/prediction-market/scripts/rewards-replay/allocate-json.js';
const RESULT_TTL_MS = 15 * 60_000;
const SPAWN_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

const resultCache = new Map<string, { atMs: number; body: any }>();

function runAllocator(capital: number): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile('node', [SCRIPT, '--capital', String(capital)], { timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e: any) { reject(new Error('allocator output not JSON: ' + e.message)); }
    });
  });
}

const EMPTY = (requested: number) => ({
  generatedAt: new Date().toISOString(), requested, capital: 0, unit: 0, offsetCents: 1,
  window: null, staleFrac: 0,
  coverage: { coveredMarketCount: null, manifestUniverse: null, truePct: null, partial: true, headerLines: [], trueNote: '' },
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
