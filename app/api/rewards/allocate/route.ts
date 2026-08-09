import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
// THE POSITION CEILING IS DERIVED HERE, AND ONLY HERE. The planner has just computed how much capital
// each market gets; the fill strategy needs exactly that number as its per-side inventory ceiling. It is
// recorded as a derived snapshot — there is no control anywhere that lets an operator type it.
import { writeAllocatedCapital } from '@/lib/maker/allocated-capital';
// Un piano calcolato è anche una dichiarazione di quali mercati contano: il raccoglitore di storico
// prezzi la legge per tenerli sottoscritti. Vale per i piani nati qui esattamente come per quelli del
// riallocatore periodico — altrimenti la copertura dipenderebbe da CHI ha chiesto il piano.
import { writeCollectorPriority } from '@/lib/rewards/collector-priority';
// IL TETTO DI CONCENTRAZIONE, LETTO DA DOVE LO LEGGE IL RIALLOCATORE PERIODICO. Fino a questa revisione
// questa route non ne passava nessuno, quindi il tetto effettivo del pannello era il capitale intero:
// sullo stesso saldo e nello stesso istante «Ottimizza» e il ciclo automatico producevano piani diversi
// (4 mercati col 76,5% su uno solo contro 7 mercati col 29,4% al massimo) senza che nulla lo dicesse.
import { MARKET_CAP_FIXED_USD, capPerMarketUsd } from '@/lib/rewards/concentration';

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
// argv[3] carries the per-market cap in dollars ("" = no cap). It is NOT a new knob typed by anyone:
// it is MARKET_CAP_FIXED_USD, the same fixed $ ceiling the periodic reallocator applies — and the same
// one the placement engine enforces at quoting time (motore-unico Regola 5) — read from the same module
// (lib/rewards/concentration.js) so the paths cannot drift. Fixed since 9 Aug 2026: when capital grows
// the system spreads over MORE markets instead of sizing up each one.
const RUNNER = 'process.stdout.write(JSON.stringify(require("/root/prediction-market/lib/rewards/allocator").planFromCollection({ capital: Number(process.argv[1]), horizonFilter: process.argv[2] === "1", maxPerMarketUsd: process.argv[3] === "" ? null : Number(process.argv[3]) })))';
const RESULT_TTL_MS = 180_000; // 3 min — the plan auto-refreshes at this cadence; recompute costs ~19s, so a fresh plan every 3 min is live-enough while the per-row data age ticks locally every 15s
const SPAWN_TIMEOUT_MS = 90_000; // planFromCollection scores the universe + builds per-tick fill curves
const MAX_BUFFER = 24 * 1024 * 1024;

const resultCache = new Map<string, { atMs: number; body: any }>();

function runAllocator(capital: number, horizonFilter: boolean, capUsd: number | null): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile('node', ['-e', RUNNER, String(capital), horizonFilter ? '1' : '0', capUsd == null ? '' : String(capUsd)], { timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout) => {
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

  // ── IL TETTO PER MERCATO ────────────────────────────────────────────────────────────────────────
  // Di difetto il 30% del capitale, lo stesso che il riallocatore periodico applica da sempre, così le
  // due strade non possono più rispondere in modo diverso alla stessa domanda. `cap=0` lo toglie —
  // esiste perché il piano senza tetto resta una cosa che si può VOLER vedere (è il piano che massimizza
  // il rendimento nominale), ma da adesso va chiesto invece di essere il difetto silenzioso.
  const capRaw = req.nextUrl.searchParams.get('cap');
  const capOverride = capRaw == null || capRaw === '' ? null : Number(capRaw);
  if (capOverride != null && (!Number.isFinite(capOverride) || capOverride < 0)) {
    return NextResponse.json({ error: 'cap must be a non-negative number of dollars (0 = no cap)', cap: capRaw }, { status: 400 });
  }
  const capUsd = capOverride == null ? capPerMarketUsd(requested) : (capOverride > 0 ? capOverride : null);

  const bucket = `${Math.round(requested * 100) / 100}:${horizonFilter ? 'auto' : 'base'}:${capUsd == null ? 'nocap' : capUsd}`;
  const cached = resultCache.get(bucket);
  if (cached && Date.now() - cached.atMs < RESULT_TTL_MS) return NextResponse.json({ ...cached.body, cached: true });

  try {
    const body = await runAllocator(requested, horizonFilter, capUsd);
    // Il tetto applicato viaggia col piano, dichiarato, perché un piano cappato e un piano concentrato
    // si somigliano nei numeri e non nella storia. `concentration` lo porta gia' dall'allocatore; questa
    // riga aggiunge da DOVE viene, che e' l'unica parte che il pannello non potrebbe dedurre.
    body.concentrationSource = capOverride == null
      ? { fissoUsd: MARKET_CAP_FIXED_USD, origin: 'difetto', note: `tetto $${MARKET_CAP_FIXED_USD} FISSO per mercato (YES+NO) — lo stesso del riallocatore periodico e del motore` }
      : { fissoUsd: null, origin: 'richiesto', note: capUsd == null ? 'nessun tetto: richiesto esplicitamente con cap=0' : `tetto $${capUsd} richiesto esplicitamente` };
    resultCache.set(bucket, { atMs: Date.now(), body });
    // Il tetto di posizione e la priorita' del raccoglitore, dall'unico piano che esiste. Il ramo per
    // profilo che stava qui non serve piu': con uno scrittore solo non c'e' nessuna mappa da fondere.
    try {
      writeAllocatedCapital({
        rows: (body?.rows ?? []).map((r: any) => ({ marketId: r.marketId, capital: r.capital })),
        capital: body?.capital ?? null,
      });
    } catch { /* the plan still stands; the strategy simply has no ceiling to read */ }
    try { writeCollectorPriority(body); } catch { /* la copertura resta quella di prima */ }
    return NextResponse.json(body);
  } catch (e: any) {
    return NextResponse.json({ error: 'allocation failed: ' + (e?.message ?? 'unknown'), requested }, { status: 500 });
  }
}
