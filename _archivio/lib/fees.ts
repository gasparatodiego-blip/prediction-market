export const PLATFORM_FEES: Record<string, { winFee: number; withdrawFee: number; label: string }> = {
  kalshi:       { winFee: 0.07,  withdrawFee: 0,    label: 'Kalshi (7% on winnings)' },
  // Polymarket charges NO winnings/settlement fee. The old 0.02 "2% on winnings" was unverified and does
  // not exist under CLOB v2 (fees are taker-only, applied at match time — see lib/polymarket-fees.js).
  // Inventing a cost is as dishonest as inventing a gain, so it is removed, not kept as a "buffer".
  // The real per-market TAKER fee is applied at the executable-price layer (arb-math / prediction API),
  // not here — this table is a win/settlement-fee model, which Polymarket has none of.
  polymarket:   { winFee: 0,     withdrawFee: 0,    label: 'Polymarket (no settlement fee; taker fee applies at trade)' },
  manifold:     { winFee: 0,     withdrawFee: 0,    label: 'Manifold (free, play money)' },
  metaculus:    { winFee: 0,     withdrawFee: 0,    label: 'Metaculus (free, play money)' },
  predictit:    { winFee: 0.10,  withdrawFee: 0.05, label: 'PredictIt (10% win + 5% withdrawal)' },
  betfair:      { winFee: 0.05,  withdrawFee: 0,    label: 'Betfair (5% commission)' },
  augur:        { winFee: 0.01,  withdrawFee: 0,    label: 'Augur (1% settlement)' },
  gnosis:       { winFee: 0.02,  withdrawFee: 0,    label: 'Gnosis/Omen (2% fee)' },
  futuur:       { winFee: 0.02,  withdrawFee: 0,    label: 'Futuur (2% fee)' },
  goodjudgment: { winFee: 0,     withdrawFee: 0,    label: 'GJ Open (free)' },
  oddsapi:      { winFee: 0,     withdrawFee: 0,    label: 'OddsAPI (reference only)' },
};

export function calculateNetROI(
  grossROI: number,
  platformA: string,
  platformB?: string,
): { netROI: number; feeBreakdown: string; totalFeePct: number } {
  const feeA = PLATFORM_FEES[platformA.toLowerCase()] ?? { winFee: 0, withdrawFee: 0 };
  const feeB = platformB ? (PLATFORM_FEES[platformB.toLowerCase()] ?? { winFee: 0, withdrawFee: 0 }) : null;

  const totalFeeRate = feeA.winFee + feeA.withdrawFee + (feeB ? feeB.winFee + feeB.withdrawFee : 0);
  const netROI       = grossROI * (1 - totalFeeRate);
  const totalFeePct  = +(totalFeeRate * 100).toFixed(1);

  const parts = [];
  if (feeA.winFee > 0)      parts.push(`${platformA}: -${+(feeA.winFee * 100).toFixed(0)}%`);
  if (feeA.withdrawFee > 0) parts.push(`${platformA} withdrawal: -${+(feeA.withdrawFee * 100).toFixed(0)}%`);
  if (feeB) {
    if (feeB.winFee > 0)      parts.push(`${platformB}: -${+(feeB.winFee * 100).toFixed(0)}%`);
    if (feeB.withdrawFee > 0) parts.push(`${platformB} withdrawal: -${+(feeB.withdrawFee * 100).toFixed(0)}%`);
  }

  return {
    netROI:       +netROI.toFixed(2),
    feeBreakdown: parts.length ? parts.join(', ') : 'No fees',
    totalFeePct,
  };
}

export function sanitizeROI(roi: number): number {
  if (!isFinite(roi) || isNaN(roi)) return 0;
  return Math.min(500, Math.max(-100, roi));
}

export function shouldFlagROI(roi: number, type: string): boolean {
  const PREDICTION_MARKET_ROI_CAP = 100;
  if (type === 'prediction_market' || type === 'cross_platform') {
    return roi > PREDICTION_MARKET_ROI_CAP;
  }
  return false;
}
