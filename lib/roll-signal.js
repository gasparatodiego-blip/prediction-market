/**
 * ROLL signal — the extra basis a carry captures by rolling into the next expiry
 * instead of closing at the first one.
 *
 * Holding a dated carry to expiry captures that contract's basis, once. Rolling means
 * closing at expiry and immediately re-opening the next contract, capturing its basis
 * too — at the cost of a second round-trip in fees.
 *
 * ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
 * The near leg is a real, locked number: its basis is observable now and converges by
 * settlement. The far leg is NOT. Today's far-expiry basis is what the market quotes
 * for that contract TODAY; by the time the near leg expires it will have moved, and the
 * roll will be executed at whatever the term structure looks like then. So this is a
 * PROJECTION at the current term structure, not a locked return — labelled as such and
 * capped like every other annualized figure.
 *
 * Requires REAL basis from BOTH expiries. If the next expiry is absent, or its basis is
 * unreadable, the signal is null and the UI shows "—". Nothing is extrapolated: a
 * missing far leg is not estimated from the near one.
 */

/**
 * @param {object} near  { executableBasisPct, daysToExpiry, feePct, expiry, contract }
 * @param {object|null} far  next expiry, same venue+asset, or null
 * @param {number} apyCap  shared APY_CAP, for labelling only
 */
function computeRollSignal(near, far, apyCap = 200) {
  if (!near || !Number.isFinite(near.executableBasisPct) || !(near.daysToExpiry > 0)) {
    return null;
  }

  const nearNetPct    = (near.executableBasisPct - (near.feePct ?? 0)) * 100;
  const nearAnnualPct = nearNetPct * 365 / near.daysToExpiry;

  // No far leg → hold-once only. Explicitly null, never inferred from the near leg.
  if (!far || !Number.isFinite(far.executableBasisPct) || !(far.daysToExpiry > near.daysToExpiry)) {
    return {
      available: false,
      reason: far ? 'FAR_LEG_UNUSABLE' : 'NO_NEXT_EXPIRY',
      holdOnce: { contract: near.contract, expiry: near.expiry, days: near.daysToExpiry,
                  netPct: nearNetPct, annualizedPct: nearAnnualPct },
      roll: null,
      extraAnnualizedPct: null,
      note: far
        ? 'Next expiry present but its basis is unreadable — no roll projection rather than an estimate.'
        : 'No further expiry listed on this venue, so there is nothing to roll into.',
    };
  }

  // The roll's SECOND leg runs from the near expiry to the far expiry. Its basis is the
  // far contract's basis today, which is the honest observable proxy — and the reason
  // this is a projection rather than a locked figure.
  const legDays = far.daysToExpiry - near.daysToExpiry;
  if (!(legDays > 0)) return null;

  const farNetPct = (far.executableBasisPct - (far.feePct ?? 0)) * 100;
  // Pro-rate the far contract's basis over just the segment the roll actually holds.
  const rollLegNetPct    = farNetPct * (legDays / far.daysToExpiry);
  const totalDays        = far.daysToExpiry;
  const totalNetPct      = nearNetPct + rollLegNetPct;
  const rolledAnnualPct  = totalNetPct * 365 / totalDays;

  const extraAnnualizedPct = rolledAnnualPct - nearAnnualPct;

  const capped = Math.abs(rolledAnnualPct) > apyCap;
  return {
    available: true,
    reason: null,
    holdOnce: { contract: near.contract, expiry: near.expiry, days: near.daysToExpiry,
                netPct: nearNetPct, annualizedPct: nearAnnualPct },
    roll: {
      intoContract: far.contract,
      intoExpiry: far.expiry,
      rollLegDays: legDays,
      rollLegNetPct,
      totalDays,
      totalNetPct,
      annualizedPct: capped ? apyCap : rolledAnnualPct,
      annualizedRaw: rolledAnnualPct,
      capped,
      // The roll pays a second round trip: close the near leg, open the far one.
      extraFeePct: (near.feePct ?? 0) * 100,
    },
    extraAnnualizedPct,
    projection: true,
    note: 'Projection at the CURRENT term structure, not a locked return. The near leg\'s '
        + 'basis is locked to its expiry; the roll leg is priced off what the next contract '
        + 'quotes today, and that will have moved by the time the roll is executed. '
        + 'Run-rate, not guaranteed.',
  };
}

/**
 * Attach a roll signal to each row by pairing it with the next expiry on the SAME
 * venue and asset. Pairing across venues would imply a roll nobody would actually do
 * (closing on one exchange and reopening on another mid-trade).
 */
function attachRollSignals(rows, apyCap = 200) {
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.venueKey}|${r.asset}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
    for (let i = 0; i < list.length; i++) {
      const near = list[i];
      const far  = list[i + 1] ?? null;
      near.rollSignal = computeRollSignal(
        { executableBasisPct: near.executableBasisPct, daysToExpiry: near.daysToExpiry,
          feePct: near.fee, expiry: near.expiry, contract: near.contract },
        far && { executableBasisPct: far.executableBasisPct, daysToExpiry: far.daysToExpiry,
                 feePct: far.fee, expiry: far.expiry, contract: far.contract },
        apyCap
      );
    }
  }
  return rows;
}

module.exports = { computeRollSignal, attachRollSignals };
