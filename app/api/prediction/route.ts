import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const PLATFORM_FEES: Record<string, number> = {
  kalshi:     0.07,  // variable curve; display only — detail page uses real formula
  polymarket: 0.00,  // 0% trading fee (as of 2024)
  predictit:  0.15,
  manifold:   0.00,
  oddsapi:    0.00,
};

// Stable URL-safe ID — djb2 hash of sorted (platform|url) pairs; no special chars.
// Computed identically by the list link and detail loader.
function stableOppId(low: any, high: any): string {
  const parts = [
    (low.platform ?? '')  + '|' + (low.url  ?? ''),
    (high.platform ?? '') + '|' + (high.url ?? ''),
  ].sort();
  const src = parts.join('\n');
  let h = 5381;
  for (let i = 0; i < src.length; i++) {
    h = (Math.imul(h, 33) ^ src.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);  // e.g. "5ozo0x" — alphanumeric, no encoding needed
}

// Platforms that use play money — opportunities involving these are SIGNAL only
const PLAY_MONEY_PLATFORMS = new Set(['manifold']);

// matcher-v2 cron schedule: 06:00, 14:00, 22:00 UTC (every 8h)
const CRON_HOURS_UTC = [6, 14, 22];
const OVERDUE_MIN    = 9 * 60; // one full cycle + 1h buffer

function nextCronRunAt(nowMs: number): number {
  const d    = new Date(nowMs);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  for (const h of CRON_HOURS_UTC) {
    const t = base + h * 3_600_000;
    if (t > nowMs) return t;
  }
  return base + 24 * 3_600_000 + CRON_HOURS_UTC[0] * 3_600_000; // 06:00 next day
}

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

      // Deduplicate by stable content hash (platform|url pairs)
      const pairKey = stableOppId(low, high);
      if (seen.has(pairKey)) { rejected++; continue; }
      seen.add(pairKey);

      const fA = feeFor(low.platform);
      const fB = feeFor(high.platform);
      const isSignal =
        PLAY_MONEY_PLATFORMS.has(low.platform?.toLowerCase()) ||
        PLAY_MONEY_PLATFORMS.has(high.platform?.toLowerCase());

      valid.push({
        id: pairKey,
        question:         o.question ?? o.title ?? '—',
        lowMarket: {
          platform:    low.platform,
          probability: low.probability,
          url:         low.url,
          urlVerified: low.urlVerified  ?? false,
          fee:         fA,
          expiresAt:   low.expiresAt  ?? null,
          yesBid:      typeof low.yesBid  === 'number' ? low.yesBid  : null,
          yesAsk:      typeof low.yesAsk  === 'number' ? low.yesAsk  : null,
        },
        highMarket: {
          platform:    high.platform,
          probability: high.probability,
          url:         high.url,
          urlVerified: high.urlVerified ?? false,
          fee:         fB,
          expiresAt:   high.expiresAt ?? null,
          yesBid:      typeof high.yesBid === 'number' ? high.yesBid : null,
          yesAsk:      typeof high.yesAsk === 'number' ? high.yesAsk : null,
        },
        spread:           o.spread,
        roi:              o.roi,
        earnPer100:       o.earnPer100 ?? null,
        confidence:       o.confidence,
        category:         o.category ?? 'unknown',
        type:             isSignal ? 'signal' : 'cashable',
        annualizedROI:    o.annualizedROI    ?? null,
        daysToResolution: o.daysToResolution ?? null,
        resolutionDate:   o.resolutionDate   ?? null,
        confirmReason:    o.confirmReason    ?? null,
        lockupFlag:       o.lockupFlag       ?? null,
      });
    }

    // Cashable first, then signal; within each group sort by net ROI desc
    valid.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'cashable' ? -1 : 1;
      return b.roi - a.roi;
    });

    const cashable   = valid.filter(o => o.type === 'cashable');
    const bestRoi    = cashable.length > 0 ? cashable[0].roi : null;
    const updatedAt  = raw.updatedAt ?? null;
    const ageMinutes = updatedAt ? Math.round((Date.now() - updatedAt) / 60_000) : null;

    const isOverdue = ageMinutes !== null && ageMinutes >= OVERDUE_MIN;
    const nextRunAt = nextCronRunAt(Date.now());

    // Honest pipeline counts from matcher-v2 output
    const confirmedCashable      = raw.stats?.confirmedCashable      ?? cashable.length;
    const totalCashableCandidates = raw.stats?.totalCashableCandidates ?? cashable.length;
    const pendingVerification    = raw.stats?.pendingVerification    ?? 0;

    return NextResponse.json({
      valid,
      rejected,
      stats: {
        validCount:               valid.length,
        cashableCount:            cashable.length,
        signalCount:              valid.filter(o => o.type === 'signal').length,
        confirmedCashable,
        totalCashableCandidates,
        pendingVerification,
        bestRoi,
        marketsTracked,
        platforms:    4,
        updatedAt,
        pipelineAge:  updatedAt ? Math.round((Date.now() - updatedAt) / 1000) : null,
      },
      freshness: {
        updatedAt,
        ageMinutes,
        isOverdue,
        nextRunAt,
        label: !ageMinutes   ? null
             : ageMinutes < 1440 ? `${Math.round(ageMinutes / 60)}h AGO`
             :                     `${Math.round(ageMinutes / 1440)}d AGO`,
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
      freshness: { updatedAt: null, ageMinutes: null, isOverdue: false, nextRunAt: null, label: null },
    });
  }
}
