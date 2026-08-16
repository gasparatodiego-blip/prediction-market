// Shared /api/crypto body builder.
//
// Extracted so the list route and the per-row detail route run the EXACT same pipeline —
// sanity net, source-of-truth enforcement, guardian, tier redaction, redaction backstop.
// Sharing it is the point: it makes it structurally impossible for the detail route's
// gating to drift from the list route's, because there is only one pipeline.

import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier, REDACTION_MAP } from '@/lib/paid-gating';
import { getCryptoSpreadsData } from '@/lib/spread-compute';
import { filterSane, enforceVerified } from '@/lib/display-sanity';
import { applyGuardian, assertRedacted } from '@/lib/guardian-suppress';
import { dryRunLegOrder, dryRunPerpSpotLegOrder, dryRunUsdcLegOrder } from '@/lib/funding-leg-order';

/** Heavy per-row fields the LIST does not need. Moved to the detail route and fetched only
 *  for the ≤25 rows the card view can actually render (6 on first paint).
 *  - slipCurve   0.88MB: only `capCase()` reads it, and only as a presence test → the list
 *                carries `slipCurveN` (the length) instead, so sort order is unchanged.
 *  - legOrder    0.63MB: card render only.
 *  - persistence 0.53MB: read by NOTHING (0 refs in app/, lib/, components/) — dead weight.
 *  - __guardian  0.24MB: card render via cautionChipRemoved().
 *  - __verify    0.04MB: card render via VerifyBadge. */
export const DETAIL_FIELDS = ['slipCurve', 'legOrder', 'persistence', '__guardian', '__verify'] as const;

/** Stable per-row identity, matching the client's own pickedKey(). */
export const rowKey = (r: { coin: string; shortExchange: string; longExchange: string }) =>
  `${r.coin}|${r.shortExchange}|${r.longExchange}`;

/**
 * Builds the FULL, fully-redacted crypto body — identical to what /api/crypto served before
 * this split. Both routes call this; neither reimplements any part of the gating.
 *
 * Slimming happens in the LIST route AFTER this returns, never inside: REDACTION_MAP covers
 * `spreads[].slipCurve[].slipBps` and friends, so stripping fields before assertRedacted
 * would quietly turn a real gating assertion into a vacuous one.
 */
export async function buildCryptoBody(): Promise<{ body: any; isPaid: boolean }> {
  const session = await getServerSession(authOptions);
  const isPaid = await getIsPaid(session);

  const data = getCryptoSpreadsData();
  data.spreads = filterSane('funding', data.spreads);
  data.perpSpot = filterSane('perp-spot', data.perpSpot);
  data.usdcArb = filterSane('usdc', data.usdcArb);

  data.spreads = enforceVerified('funding', data.spreads);
  data.perpSpot = enforceVerified('perp-spot', data.perpSpot);
  data.usdcArb = enforceVerified('usdc', data.usdcArb);

  data.spreads = applyGuardian('funding', data.spreads).rows;
  data.perpSpot = applyGuardian('perp-spot', data.perpSpot).rows;
  data.usdcArb = applyGuardian('usdc', data.usdcArb).rows;

  const body = redactForTier(data, 'crypto', isPaid);
  if (!isPaid) assertRedacted(body, REDACTION_MAP['crypto'], { log: console.log });

  // Execution-order dry-run — attached after redaction so it cannot interfere with gating.
  // Measurement of PUBLIC order-book depth, not a derived edge, so it is not tier-gated.
  // It reads a local JSON sidecar and ranks: it places nothing and touches no credential.
  const now = Date.now();
  if (Array.isArray(body?.spreads)) {
    for (const r of body.spreads) {
      r.legOrder = dryRunLegOrder(r.coin, r.shortExchange, r.longExchange, now);
    }
  }
  // The other two strategy lanes on this tab get the same dry-run. Both are small (25 and
  // 4 rows), so unlike `spreads` they ship it inline on the list payload — the list route
  // only strips DETAIL_FIELDS from `spreads`.
  if (Array.isArray(body?.perpSpot)) {
    for (const r of body.perpSpot) {
      r.legOrder = dryRunPerpSpotLegOrder(r.coin, r.shortVenue, r.spotVenueSuggested, now);
    }
  }
  if (Array.isArray(body?.usdcArb)) {
    for (const r of body.usdcArb) {
      r.legOrder = dryRunUsdcLegOrder(r.coin, r.shortVenue, r.shortMargin, r.longVenue, r.longMargin, now);
    }
  }

  return { body, isPaid };
}
