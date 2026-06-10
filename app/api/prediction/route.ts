import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const PLATFORM_FEES: Record<string, number> = {
  kalshi:     0.07,
  polymarket: 0.02,
  predictit:  0.15,
  manifold:   0.00,
  oddsapi:    0.00,
};

// Platforms that use play money — opportunities involving these are SIGNAL only
const PLAY_MONEY_PLATFORMS = new Set(['manifold']);

function feeFor(platform: string): number {
  return PLATFORM_FEES[platform?.toLowerCase()] ?? 0;
}

function isValidOpp(o: any): string | null {
  const low  = o?.lowMarket;
  const high = o?.highMarket;

  // Both legs must exist
  if (!low || !high) return 'missing legs';

  // Prices (probabilities 0–100 → fractions 0–1) must be strictly between 0 and 1
  const pLow  = typeof low.probability  === 'number' ? low.probability  / 100 : null;
  const pHigh = typeof high.probability === 'number' ? high.probability / 100 : null;
  if (pLow  == null || pLow  <= 0 || pLow  >= 1) return `bad low price (${low.probability})`;
  if (pHigh == null || pHigh <= 0 || pHigh >= 1) return `bad high price (${high.probability})`;

  // Fees must each be ≤ 15%
  const fA = feeFor(low.platform);
  const fB = feeFor(high.platform);
  if (fA > 0.15) return `fee too high on ${low.platform} (${fA})`;
  if (fB > 0.15) return `fee too high on ${high.platform} (${fB})`;

  // Net ROI: finite, positive, ≤ 50%
  if (!isFinite(o.roi) || o.roi <= 0) return `non-positive roi (${o.roi})`;
  if (o.roi > 50) return `roi too high, likely unreliable (${o.roi}%)`;

  // URLs and platform names required
  if (!low.platform  || !high.platform)  return 'missing platform name';
  if (!low.url       || !high.url)       return 'missing url';

  return null; // valid
}

export async function GET() {
  try {
    const raw = JSON.parse(fs.readFileSync('/tmp/arbitrage-opportunities.json', 'utf8'));
    const allOpps: any[] = raw.opportunities ?? [];

    // Market count from markets-raw.json (best-effort)
    let marketsTracked = 0;
    try {
      const mraw = JSON.parse(fs.readFileSync('/tmp/markets-raw.json', 'utf8'));
      marketsTracked =
        (mraw.predictit?.length ?? 0) +
        (mraw.manifold?.length  ?? 0) +
        (mraw.kalshi?.length    ?? 0) +
        (mraw.polymarket?.length ?? 0);
    } catch { /* markets-raw.json may be absent when fetcher is stopped */ }

    const seen  = new Set<string>();
    const valid: any[] = [];
    let rejected = 0;

    for (const o of allOpps) {
      const reason = isValidOpp(o);
      if (reason) { rejected++; continue; }

      const low  = o.lowMarket;
      const high = o.highMarket;

      // Deduplicate by sorted pair id
      const pairKey = [low.id, high.id].sort().join('::');
      if (seen.has(pairKey)) { rejected++; continue; }
      seen.add(pairKey);

      const fA = feeFor(low.platform);
      const fB = feeFor(high.platform);
      const isSignal =
        PLAY_MONEY_PLATFORMS.has(low.platform?.toLowerCase()) ||
        PLAY_MONEY_PLATFORMS.has(high.platform?.toLowerCase());

      valid.push({
        id: pairKey,
        question:   o.question,
        lowMarket:  { platform: low.platform,  probability: low.probability,  url: low.url,  fee: fA, expiresAt: low.expiresAt  ?? null },
        highMarket: { platform: high.platform, probability: high.probability, url: high.url, fee: fB, expiresAt: high.expiresAt ?? null },
        spread:     o.spread,
        roi:        o.roi,
        earnPer100: o.earnPer100,
        confidence: o.confidence,
        category:   o.category ?? 'unknown',
        type:       isSignal ? 'signal' : 'cashable',
      });
    }

    // Cashable first, then signal; within each group sort by net ROI desc
    valid.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'cashable' ? -1 : 1;
      return b.roi - a.roi;
    });

    const cashable = valid.filter(o => o.type === 'cashable');
    const bestRoi  = cashable.length > 0 ? cashable[0].roi : null;

    return NextResponse.json({
      valid,
      rejected,
      stats: {
        validCount:    valid.length,
        cashableCount: cashable.length,
        signalCount:   valid.filter(o => o.type === 'signal').length,
        bestRoi,
        marketsTracked,
        platforms:    4,
        updatedAt:    raw.updatedAt ?? null,
        pipelineAge:  raw.updatedAt ? Math.round((Date.now() - raw.updatedAt) / 1000) : null,
      },
    });
  } catch {
    return NextResponse.json({
      valid:    [],
      rejected: 0,
      stats: {
        validCount: 0, cashableCount: 0, signalCount: 0,
        bestRoi: null, marketsTracked: 0, platforms: 4,
        updatedAt: null, pipelineAge: null,
      },
    });
  }
}
