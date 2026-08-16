import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier, REDACTION_MAP } from '@/lib/paid-gating';
import { assertRedacted } from '@/lib/guardian-suppress';
import { isSanePolymarketLevel } from '@/lib/reward-gating';
import { estimateReward, type MarketSnapshot } from '@/lib/rewards-estimate';
import { LANDING_CAPITAL_BASIS } from '@/lib/honest-display';
import { assemblePaperBook } from '@/lib/paper-book-assemble';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────────────────
// /api/paper-book — the unified, honest forward-paper book.
//
// HONEST-ENGINE (absolute):
//   • Paper P&L headline = executable, within-capacity value ONLY. THIN "not
//     executable at size" value is a SEPARATE labelled field, never merged in,
//     never dropped. Both come from lib/paper-book-assemble (the ONE aggregation
//     that agent32's Telegram report also uses — no parallel recompute).
//   • Liquidity rewards is a LIVE block, not paper: nothing is executed so nothing
//     is realized (realizedUsd = null → "—"); the forward reward is NOT
//     deterministic so it is never projected (a labelled est run-rate signal only,
//     after the 2%/day thin-book sanity gate, reusing lib/rewards-estimate — the
//     SAME call the landing card and Rewards tab make). Never in any P&L total.
//   • Signal-only venues (Futuur / Manifold / PredictIt) are mid-price-only →
//     never cashable, never in any P&L total. Returned as a signal-only descriptor.
//   • Derived edge is redacted SERVER-SIDE for non-paid users (real null, never a
//     blurred/teaser number) via lib/paid-gating REDACTION_MAP['paper-book'].
// ─────────────────────────────────────────────────────────────────────────────

const STORE_FILE   = path.join(process.cwd(), 'data', 'paper-trades.json');
const REWARDS_FILE  = '/tmp/liquidity-rewards.json';
const REWARDS_STALE_MS = 35 * 60_000;   // agent24/25 scan every ~15 min

function readJsonSafe(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

// LIVE liquidity-rewards block. Realized = null (Edgeradar places no orders, so
// nothing is accrued — honest "—", not $0-implied-cashable). Forward = never
// projected. estRunRate = the SINGLE highest est net/day per $1k among current
// SANE Polymarket reward markets (isSanePolymarketLevel = zero flags, which is
// where the 2%/day thin-book cap is enforced), computed with lib/rewards-estimate —
// the exact same call the landing card makes. It is a labelled ESTIMATE / run-rate,
// never counted in any P&L total.
function buildLiquidityBlock() {
  const norm = readJsonSafe(REWARDS_FILE);
  const generatedAt = norm?.meta?.generatedAt ?? null;
  const stale = generatedAt ? (Date.now() - new Date(generatedAt).getTime() > REWARDS_STALE_MS) : true;
  const mkts = Array.isArray(norm?.markets) ? norm.markets : [];

  let best: number | null = null;
  let eligibleCount = 0;
  for (const m of mkts) {
    if (m.venue !== 'polymarket') continue;
    if (!isSanePolymarketLevel({ flags: m.flags ?? [] })) continue;   // 2%/day THIN_CAP gate lives here
    const snapshot: MarketSnapshot = {
      venue: 'polymarket',
      midpoint: m.midpoint, maxSpread: m.maxSpread, minSize: m.minSize,
      dailyPool: m.dailyPool, qualifyingLiquidity: m.qualifyingLiquidity,
      bookDepthAtBand: m.bookDepthAtBand, volatilityStdev: m.volatilityStdev ?? null,
      twoSidedRequired: m.twoSidedRequired, sides: m.sides ?? null,
    };
    const dist = (m.maxSpread ?? 2) / 2;   // rest mid-band, same as landing / Rewards tab
    const r = estimateReward({ venue: 'polymarket', capital: LANDING_CAPITAL_BASIS, twoSided: true, distanceCents: dist, market: snapshot });
    if (r.netPerDay != null && r.netPerDay > 0) { eligibleCount++; if (best == null || r.netPerDay > best) best = r.netPerDay; }
  }

  return {
    kind: 'live' as const,
    label: 'Liquidity rewards',
    chip: 'signal' as const,     // conditional incentive — never a locked arb
    platform: 'Polymarket',
    inPnlTotal: false,
    realizedUsd: null,           // no orders placed → nothing accrued → "—" (never $0-as-cashable)
    forwardProjected: null,      // forward reward NOT deterministic → never projected
    forwardNote: 'Forward reward is not deterministic (pool × your-share depends on placement, future competitor depth and fills) — never projected.',
    realizedNote: 'Live signal only — Edgeradar places no maker orders, so no reward is accrued/realized here.',
    estRunRate: {
      // est net/day per $1k, single highest sane market — LABELLED estimate, run-rate,
      // after the 2%/day thin-book sanity gate. Not guaranteed, not in any total.
      bestNetPerDay1k: best == null ? null : Math.round(best * 100) / 100,
      eligibleCount,
      capitalBasisUsd: LANDING_CAPITAL_BASIS,
      label: 'est net/day per $1,000 · run-rate, not guaranteed',
    },
    stale,
    generatedAt,
  };
}

// Mid-price-only venues: never cashable per honest-engine, never in any P&L total.
function buildSignalOnlyBlock() {
  return {
    kind: 'signal-only' as const,
    label: 'Signal-only venues',
    chip: 'signal' as const,
    inPnlTotal: false,
    venues: ['Futuur', 'Manifold', 'PredictIt'],
    note: 'Mid-price-only platforms — no executable bid/ask. Signal only, never cashable, never included in any paper P&L total.',
  };
}

export async function GET() {
  const store = readJsonSafe(STORE_FILE);
  if (!store || !Array.isArray(store.trades)) {
    return NextResponse.json(
      { ok: false, error: 'paper book not initialized', headline: null, strategies: [], liquidity: null, signalOnly: buildSignalOnlyBlock() },
      { status: 200 },
    );
  }

  // ONE honest aggregation — the same math agent32's daily report uses.
  const book = assemblePaperBook(store);

  const payload = {
    ok: true,
    kind: 'paper' as const,
    simulated: true,
    meta: book.meta,
    headline: book.headline,
    equityCurve: book.equityCurve,
    strategies: book.strategies,
    copy: book.copy,
    liquidity: buildLiquidityBlock(),
    signalOnly: buildSignalOnlyBlock(),
    excluded: book.excluded,
    // Annualized honesty cap surfaced for the UI (never render >200%/yr as guaranteed).
    annualizedCapNote: '>200%/yr · run-rate, not guaranteed',
  };

  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);

  // Redact derived-edge SERVER-SIDE for non-paid users: a real null, never a blur
  // over a real value. Paid → unchanged. isPaid is returned so the client renders
  // the calm unlock/"—" state (lib Redacted), never "null"/"NaN"/"$0".
  const body = redactForTier({ ...payload, isPaid }, 'paper-book', isPaid);
  if (!isPaid) assertRedacted(body, REDACTION_MAP['paper-book'], { log: console.log });

  return NextResponse.json(body);
}
