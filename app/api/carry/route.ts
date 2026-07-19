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

  const body = redactForTier({
    agentStatus,
    updatedAt:     data.updatedAt,
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
