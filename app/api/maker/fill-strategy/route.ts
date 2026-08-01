import { NextRequest, NextResponse } from 'next/server';
import {
  readFillStrategyConfig, setFillStrategy, paramsFor,
  DEFAULT_TAKE_PROFIT_CENTS, DEFAULT_STOP_LOSS_PCT, DEFAULT_MAX_SLIPPAGE_PCT,
  TAKE_PROFIT_RANGE, STOP_LOSS_RANGE, SLIPPAGE_RANGE,
} from '@/lib/maker/fill-strategy-config';
import { readAllocatedCapitalAll, readAllocatedCapital } from '@/lib/maker/allocated-capital';
import { readAutoRepriceConfig } from '@/lib/maker/auto-reprice-config';
import fs from 'fs';
import path from 'path';

/** Market titles, read from the same reward board the rest of the console reads. Best-effort: a market
 *  with no readable title shows its short id, never a blank row. */
function titleMap(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'data', 'liquidity-rewards.json'), 'utf8');
    for (const row of (JSON.parse(raw).markets ?? [])) {
      if (row?.conditionId && typeof row.question === 'string' && row.question.trim()) {
        m.set(String(row.conditionId).trim().toLowerCase(), row.question);
      }
    }
  } catch { /* titles are a nicety; their absence never hides a market */ }
  return m;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/maker/fill-strategy — the switches and tunables for the fill strategy.
 *
 * GET  returns the whole state: the master switch, one entry per ENABLED market with its own switch, its
 *      take-profit and stop-loss, and its DERIVED position ceiling (read-only, from the allocation plan).
 * POST flips a switch or sets a tunable. It writes configuration ONLY — it places no order, signs
 *      nothing and touches no key. The strategy cycle is what acts, and only when both switches are on.
 *
 * Admin-gated by middleware like every other /api/maker/* route.
 *
 * THERE IS NO WRITE PATH FOR THE CEILING. The POST body has no field for it, the config module refuses
 * any key that is not one of the three tunables, and the value shown here is read from the derived
 * snapshot the allocation planner writes. An operator cannot raise their own inventory limit from this
 * screen, which is the entire point of deriving it.
 */

export async function GET() {
  const cfg = readFillStrategyConfig();
  const capAll = readAllocatedCapitalAll();
  // The markets to show: those the maker may actually quote (the auto-reprice enabled list is the same
  // allowlist the rest of the panel uses), plus any this strategy already has an opt-in for.
  const ar = readAutoRepriceConfig();
  const ids = Array.from(new Set([
    ...((ar.enabledMarketIds || []) as string[]),
    ...((ar.optedInMarketIds || []) as string[]),
    ...Object.keys(cfg.markets || {}),
  ].map((s) => String(s).trim().toLowerCase()).filter(Boolean)));

  const titles = titleMap();
  const markets = ids.map((id) => {
    const rec = (cfg.markets as any)[id] || null;
    const p = paramsFor(id);
    const cap = readAllocatedCapital(id);
    return {
      marketId: id,
      title: titles.get(id) ?? null,
      shortId: `${id.slice(0, 10)}…${id.slice(-4)}`,
      enabled: !!(rec && rec.enabled === true),
      effectivelyEnabled: cfg.globalEnabled && !!(rec && rec.enabled === true),
      takeProfitCents: p.takeProfitCents, takeProfitIsDefault: p.takeProfitIsDefault,
      takeProfitMirrorsEntry: p.takeProfitMirrorsEntry,
      stopLossPct: p.stopLossPct, stopLossIsDefault: p.stopLossIsDefault,
      maxSlippagePct: p.maxSlippagePct, maxSlippageIsDefault: p.maxSlippageIsDefault,
      // DERIVED, read-only. null = no ceiling readable ⇒ the strategy withholds replacement orders.
      positionCapUsd: cap.capUsd, capReadable: cap.readable, capStale: cap.stale,
      capAgeSec: cap.ageSec, capReason: cap.reason,
      record: rec,
    };
  });

  return NextResponse.json({
    at: new Date().toISOString(),
    readable: cfg.readable, error: cfg.error,
    globalEnabled: cfg.globalEnabled, globalRecord: cfg.globalRecord ?? null,
    markets,
    allocation: { readable: capAll.readable, updatedAt: capAll.updatedAt, ageSec: capAll.ageSec, capital: capAll.capital },
    defaults: { takeProfitCents: DEFAULT_TAKE_PROFIT_CENTS, stopLossPct: DEFAULT_STOP_LOSS_PCT, maxSlippagePct: DEFAULT_MAX_SLIPPAGE_PCT },
    ranges: { takeProfit: TAKE_PROFIT_RANGE, stopLoss: STOP_LOSS_RANGE, slippage: SLIPPAGE_RANGE },
    note: 'Il tetto posizione è DERIVATO dal capitale allocato dal pianificatore e non è scrivibile da qui.',
  });
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'body JSON non valido' }, { status: 400 }); }

  const scope = body?.scope === 'global' ? 'global' : 'market';
  const marketId = typeof body?.marketId === 'string' ? body.marketId : null;
  const enabled = typeof body?.enabled === 'boolean' ? body.enabled : null;
  const patch = (body?.patch && typeof body.patch === 'object') ? body.patch : null;

  const res = setFillStrategy({
    scope, marketId, enabled, patch,
    by: 'fill-strategy-panel',
    reason: typeof body?.reason === 'string' ? body.reason : 'pannello strategia sul fill',
  });
  if (!res.ok) return NextResponse.json({ ...res, note: 'nulla è stato scritto' }, { status: 400 });
  return NextResponse.json({ ...res, note: 'configurazione scritta. Nessun ordine è stato piazzato: la strategia agisce solo al prossimo fill, e solo con entrambi gli interruttori accesi.' });
}
