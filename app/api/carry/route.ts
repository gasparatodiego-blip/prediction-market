import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier, REDACTION_MAP } from '@/lib/paid-gating';
import { isExpired } from '@/lib/instrument-expiry';
import { filterSane, enforceVerified } from '@/lib/display-sanity';
import { applyGuardian, assertRedacted } from '@/lib/guardian-suppress';
import { dryRunBasisLegOrder } from '@/lib/basis-leg-order';

export const dynamic = 'force-dynamic';

const BASIS_FILE = '/tmp/basis-opportunities.json';
const STALE_MS   = 15 * 60_000; // agent runs every 5 min

export async function GET() {
  let data: any = null;
  let agentStatus: 'running' | 'stale' | 'offline' = 'offline';

  try {
    data = JSON.parse(fs.readFileSync(BASIS_FILE, 'utf8'));
    const age = Date.now() - new Date(data.updatedAt ?? 0).getTime();
    agentStatus = age < STALE_MS ? 'running' : 'stale';
  } catch { /* file absent */ }

  if (!data) {
    return NextResponse.json({
      agentStatus:  'offline',
      updatedAt:    null,
      opportunities: [],
      backwardation: [],
      summary:      { count: 0, bestNetAnnualized: null, bestContract: null, bestExchange: null, bestAsset: null },
      spot:         {},
      disclaimer:   '',
    });
  }

  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);

  // Render-time expired-instrument guard (single source: lib/instrument-expiry).
  // Defense in depth behind agent19's producer filter — an expired dated future must
  // never reach a card. Log rejects so a producer regression is never silent.
  const now = Date.now();
  const keepLive = (rows: any[], label: string) =>
    (rows ?? []).filter((r) => {
      if (isExpired(r, now)) {
        console.log(`[carry] excluded expired instrument ${label}: ${r?.contract ?? r?.instrument ?? '?'} (expiry ${r?.expiry ?? '?'})`);
        return false;
      }
      return true;
    });

  // Layer: expired filter (Phase 2, specific log) then the render-time sanity net
  // (absurd/over-cap/missing-expiry money-field checks).
  // Source-of-truth enforcement: drop venue-contradicted rows, flag+demote
  // unreachable ones, tag verified rows for the badge.
  // Guardian (rules A–E) is the last stage: auto-suppresses honest-engine violations
  // (over-cap net, OI/proxy capacity, thin-book "cashable", false verifying badge, …).
  // Display-only, never rewrites source; agent26 runs the same module for alerting.
  const opportunities = applyGuardian('basis',
    enforceVerified('basis', filterSane('basis', keepLive(data.opportunities, 'opportunity'), now), now),
    { now }).rows;
  const backwardation = applyGuardian('basis',
    enforceVerified('basis', filterSane('basis', keepLive(data.backwardation, 'backwardation'), now), now),
    { now }).rows;

  // Execution-order DRY-RUN (read-only). Reads agent19's persisted ladders — the SAME
  // depth capacityUsd was measured from — and asks lib/leg-order which leg is hardest,
  // so it would be placed first. Buy the spot and miss the short future and you are long
  // naked crypto; hardest-first is what prevents that. Placed AFTER the guardian so a
  // suppressed row is never ranked. Places nothing, submits nothing, reads no credential.
  // Fails closed: no/stale ladder → usable:false with the reason, never a guessed order.
  const withDryRun = opportunities.map((o: any) => ({
    ...o,
    legOrder: dryRunBasisLegOrder(o.asset, o.venueKey, o.contract, now),
  }));

  // ── Carry OPTIMIZATION overlay (CC-2/2b/2c), computed live from the same /tmp feeds
  // this route already serves plus data/venue-fees-official.json — not a stale artifact.
  // Attaches per row: structured quote-asset risk tier, the signed risk-free delta,
  // min(legs) capacity, fee provenance, and the ranked venue comparison for that
  // coin+expiry group. Labelling and comparison only — it never rewrites the row's own
  // basis/net/capacity, which stay exactly as agent19 measured them.
  // Fails soft: if the engine cannot build, rows render without the overlay rather than
  // taking the tab down, and nothing is fabricated in its place.
  const optimized: Record<string, any> = {};
  const groups: Record<string, any> = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildOptimized } = require('@/lib/carry-optimize');
    const doc = buildOptimized();
    for (const g of doc.opportunities ?? []) {
      // The best-ranked route is what the card recommends, and it is not always the
      // row's own venue — for ETH it is the Deribit single-venue route, which buys spot
      // against USDe. That quote risk therefore belongs on the card face, not buried in
      // a collapsed drawer the user may never open.
      const bestOpt = (g.options ?? [])[0] ?? null;
      groups[g.key] = {
        key:        g.key,
        bestVenue:  g.best?.venue ?? null,
        bestWhy:    g.best?.why ?? null,
        venueCount: g.venueCount ?? 0,
        bestRouteType:       bestOpt?.routeType ?? null,
        bestSpotInstrument:  bestOpt?.spotInstrument ?? null,
        bestQuoteAsset:      bestOpt?.quoteAsset ?? null,
        bestQuoteRiskTier:   bestOpt?.quoteRiskTier ?? null,
        bestQuoteRiskFlagged: bestOpt?.quoteRiskFlagged ?? null,
        bestQuoteRiskLabel:  bestOpt?.quoteRiskLabel ?? null,
        bestQuoteRiskReason: bestOpt?.quoteRiskReason ?? null,
        options: (g.options ?? []).map((o: any) => ({
          venue:               o.venue,
          contract:            o.contract,
          routeType:           o.routeType,
          executableBasisPct:  o.executableBasisPct,
          netAnnualizedPct:    o.netAnnualizedPct,
          netAnnualizedCapped: o.netAnnualizedCapped,
          riskFreeDeltaPct:    o.riskFreeDeltaPct,
          beatsRiskFree:       o.beatsRiskFree,
          capacityUsd:         o.capacityUsd,
          capacitySource:      o.capacitySource,
          capacityBoundBy:     o.capacityBoundBy ?? null,
          feePct:              o.feePct,
          feeVerified:         o.feeVerified,
          quoteAsset:          o.quoteAsset ?? null,
          quoteRiskTier:       o.quoteRiskTier ?? null,
          quoteRiskFlagged:    o.quoteRiskFlagged ?? null,
          quoteRiskLabel:      o.quoteRiskLabel ?? null,
          spotInstrument:      o.spotInstrument ?? null,
        })),
      };
      for (const o of g.options ?? []) {
        // Key the per-row overlay to agent19's own two-venue rows; single-venue routes
        // have no agent19 counterpart and surface only inside the venue comparison.
        if (o.routeType !== 'TWO_VENUE') continue;
        optimized[`${o.venueKey}|${o.contract}`] = {
          groupKey:            g.key,
          quoteAsset:          o.quoteAsset ?? null,
          quoteRiskTier:       o.quoteRiskTier ?? null,
          quoteRiskFlagged:    o.quoteRiskFlagged ?? null,
          quoteRiskLabel:      o.quoteRiskLabel ?? null,
          quoteRiskReason:     o.quoteRiskReason ?? null,
          spotInstrument:      o.spotInstrument ?? null,
          riskFreePct:         o.riskFreePct ?? null,
          riskFreeDeltaPct:    o.riskFreeDeltaPct ?? null,
          beatsRiskFree:       o.beatsRiskFree ?? null,
          optCapacityUsd:      o.capacityUsd ?? null,
          optCapacitySource:   o.capacitySource ?? null,
          optCapacityBoundBy:  o.capacityBoundBy ?? null,
          netAnnualizedCapped: o.netAnnualizedCapped ?? null,
          netAnnualizedLabel:  o.netAnnualizedLabel ?? null,
          feePct:              o.feePct ?? null,
          feeVerified:         o.feeVerified ?? null,
          feeOfficialFraction: o.feeOfficialFraction ?? null,
          feeLegs:             o.feeLegs ?? null,
          isBestVenue:         g.best?.venue === o.venue,
        };
      }
    }
  } catch (e: any) {
    console.warn('[carry] optimization overlay unavailable:', e?.message);
  }

  const withOptimized = withDryRun.map((o: any) => {
    const opt = optimized[`${o.venueKey}|${o.contract}`] ?? null;
    return { ...o, carryOpt: opt, venueCompare: opt ? groups[opt.groupKey] ?? null : null };
  });

  // ── Card projection for /dashboard/carry ────────────────────────────────────
  // A presentation shape only. Every number is carried through from what agent19
  // measured or lib/carry-optimize derived; the only new values are net $/day (a
  // restatement of the agent's net annualized at a stated capital basis) and the
  // convergence fraction. Nothing here recomputes basis, the APY cap, or the binding leg.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { netUsdPerDay, convergence, isBelowRiskFree, RISK_FREE_PCT, CARRY_CAPITAL_BASIS } = require('@/lib/carry-display');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { firstSeenMap } = require('@/lib/carry-first-seen');
  const firstSeen = firstSeenMap();

  const basisCards = withOptimized.map((o: any) => {
    const opt = o.carryOpt ?? null;
    // net annualized arrives as a FRACTION from agent19 (0.0406 = 4.06%/yr).
    const netFrac = typeof o.netAnnualizedExecutable === 'number' ? o.netAnnualizedExecutable : null;
    const annualizedPct = netFrac == null ? null : netFrac * 100;
    // Capacity: prefer carry-optimize's min(legs) with its binding leg; fall back to
    // agent19's own measured figure, which is the futures book only — labelled as such
    // so the card never implies a min() that was not computed.
    const optCap  = opt?.optCapacityUsd ?? null;
    const useOpt  = optCap != null;
    const capacityUsd = useOpt ? optCap : (o.capacityUsd ?? null);
    const bindingLeg  = useOpt
      ? (opt?.optCapacityBoundBy ?? null)
      : (o.capacityUsd != null ? 'futures leg (spot depth unmeasured)' : null);
    const tenorDays = firstSeen[o.contract] ?? null;
    const conv = convergence(tenorDays, o.daysToExpiry);

    // Fee model for the position calculator. The legs are agent19's per-venue round-trip
    // rates — real, itemised, and already the basis of its net figure, so the calculator
    // scales the SAME fees rather than inventing a table.
    //
    // They are NOT independently verified: data/venue-fees-official.json records Bybit,
    // OKX and Binance as UNKNOWN because those venues gate their schedules behind auth,
    // and its own policy refuses to substitute blog or docs figures. carryOpt.feeVerified
    // is currently false on every served row. So isAssumption is true here for a measured
    // reason, and the UI must tell the user to check their own tier.
    const feeLegs = Array.isArray(o.feeLegs) ? o.feeLegs : null;
    const feeVerified = opt?.feeVerified === true;
    const feeModel = feeLegs
      ? {
          legs: feeLegs.map((l: any) => ({ label: l.label ?? null, pct: typeof l.pct === 'number' ? l.pct * 100 : null })),
          totalPct: typeof o.fee === 'number' ? o.fee * 100 : null,
          verified: feeVerified,
          isAssumption: !feeVerified,
          source: feeVerified ? 'venue-fees-official' : 'agent19 round-trip model (base tier)',
          note: feeVerified
            ? 'verified against the official venue fee table'
            : 'base-tier estimate — verify against your own fee tier before sizing',
        }
      : null;

    return {
      id:                  `${o.venueKey}|${o.contract}`,
      asset:               o.asset ?? null,
      venue:               o.exchange ?? null,
      contract:            o.contract ?? null,
      expiryDate:          o.expiry ?? null,
      daysToExpiry:        typeof o.daysToExpiry === 'number' ? o.daysToExpiry : null,
      tenorDays:           conv?.tenorDays ?? null,
      elapsedDays:         conv?.elapsedDays ?? null,
      convergenceFraction: conv?.fraction ?? null,
      // Executable legs — what you would actually pay/receive, never mid.
      spotAsk:             typeof o.spotAsk === 'number' ? o.spotAsk : null,
      futureBid:           typeof o.futureBid === 'number' ? o.futureBid : null,
      executableBasisPct:  typeof o.executableBasisPct === 'number' ? o.executableBasisPct * 100 : null,
      indicativeBasisPct:  typeof o.indicativeBasisPct === 'number' ? o.indicativeBasisPct * 100 : null,
      annualizedPct,
      annualizedCapped:    opt?.netAnnualizedCapped ?? null,
      annualizedLabel:     opt?.netAnnualizedLabel ?? null,
      belowRiskFree:       annualizedPct == null ? null : isBelowRiskFree(annualizedPct),
      riskFreePct:         RISK_FREE_PCT,
      netUsdPerDay:        netUsdPerDay(netFrac),
      capitalBasisUsd:     CARRY_CAPITAL_BASIS,
      capacityUsd,
      bindingLeg,
      direction:           o.direction ?? o.type ?? null,
      coinMargined:        o.coinMargined === true,
      feeModel,
    };
  });

  const bestApyPct = basisCards.reduce(
    (m: number | null, c: any) => (c.annualizedPct != null && (m == null || c.annualizedPct > m) ? c.annualizedPct : m),
    null as number | null,
  );

  const body = redactForTier({
    agentStatus,
    updatedAt:     data.updatedAt,
    basisCards,
    carryMeta: {
      riskFreePct:     RISK_FREE_PCT,
      capitalBasisUsd: CARRY_CAPITAL_BASIS,
      bestApyPct,
      bestBeatsRiskFree: bestApyPct == null ? null : bestApyPct > RISK_FREE_PCT,
      // Convergence has not been observed yet: the earliest contract in the book settles
      // after 2026-07-31, so every figure here is modelled from executable bid/ask rather
      // than a realized settlement. Stated on the card surface, not buried.
      convergenceObserved: false,
      convergenceNote:
        'convergence not yet observed — first contract settles after 31 Jul 2026. ' +
        'figures modeled from executable bid/ask, not realized settlement.',
    },
    opportunities: withOptimized,
    backwardation,
    summary:       data.summary        ?? {},
    spot:          data.spot           ?? {},
    disclaimer:    data.disclaimer     ?? '',
    // Tier flag for the client render boundary: a paid user is never behind the
    // paywall, so the UI must show honest "—" for genuinely-null gated fields
    // (e.g. guardian-suppressed OI/proxy capacity) instead of the upgrade lock.
    // Not a redacted field; no numbers change.
    isPaid,
  }, 'carry', isPaid);

  // Guardian H (rules 31–33): backstop the redaction — null + CRITICAL any leaked
  // derived-edge field on the free tier (display-only; never fabricates). No-op for paid.
  if (!isPaid) assertRedacted(body, REDACTION_MAP['carry'], { log: console.log });

  return NextResponse.json(body);
}
