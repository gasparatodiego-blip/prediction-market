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

// Platforms that are signal-only — opportunities involving any of these are NEVER cashable.
// Manifold: play money.
// PredictIt: real money but 10% profit fee + 5% withdrawal fee on total payout makes all
//   observed spreads negative after fees; $850 per-contract position cap prevents meaningful size.
// Futuur: real money but exposes only mid-price (no executable CLOB); spread unconfirmable.
const SIGNAL_ONLY_PLATFORMS = new Set(['manifold', 'predictit', 'futuur']);

// Discovery cron: every 3h (0 */3 * * *)
// isOverdue = last discovery run missed a slot (>4h)
const DISCOVERY_OVERDUE_MIN = 4 * 60;  // 4h
const REPRICE_OVERDUE_MIN   = 40;      // 40 min — re-pricer stalled

function nextDiscoveryRunAt(nowMs: number): number {
  // Cron: 0 */3 * * * → runs at 00, 03, 06, 09, 12, 15, 18, 21 UTC
  const d    = new Date(nowMs);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  for (let h = 0; h < 24; h += 3) {
    const t = base + h * 3_600_000;
    if (t > nowMs) return t;
  }
  return base + 24 * 3_600_000; // 00:00 next day
}

function feeFor(platform: string): number {
  return PLATFORM_FEES[platform?.toLowerCase()] ?? 0;
}

// Minimum executable $ size for cashable label.
// Pairs below this threshold pass structural checks but are reclassified to signal.
const CASHABLE_MIN_SIZE_USD    = 50;
// Minimum IDF-derived confidence for cashable label (mirrors matcher-v2 constant).
const CASHABLE_MIN_CONFIDENCE  = 0.85;

// Detect Kalshi single-stage mutually-exclusive outcomes (eliminated AT stage X) that
// were falsely paired with cumulative Polymarket "reach stage X or further" markets.
// These legs are NOT complements: advancing past the stated stage means BOTH legs pay $0.
// This guard fires on the current discovery file until the next matcher run applies the fix.
const STAGEOFELIM_RE    = /STAGEOFELIM/i;
const CUMULATIVE_PM_RE  = /\breach\b|\bqualif|\badvance|\bfurthest\b/i;

function hasMutuallyExclusiveVsCumulativeMismatch(o: any): boolean {
  const low = o?.lowMarket; const high = o?.highMarket;
  if (!low || !high) return false;
  const kaId  = low.platform  === 'kalshi'     ? low.id  : high.platform === 'kalshi'     ? high.id  : '';
  const pmLeg = low.platform  === 'polymarket' ? low      : high.platform === 'polymarket' ? high     : null;
  if (!pmLeg) return false;
  const pmTitle = String(o.title ?? o.question ?? '').toLowerCase();
  return STAGEOFELIM_RE.test(kaId) && CUMULATIVE_PM_RE.test(pmTitle);
}

function isValidOpp(o: any): string | null {
  const low  = o?.lowMarket;
  const high = o?.highMarket;

  if (!low || !high) return 'missing legs';

  const pLow  = typeof low.probability  === 'number' ? low.probability  / 100 : null;
  const pHigh = typeof high.probability === 'number' ? high.probability / 100 : null;
  if (pLow  == null || pLow  <= 0 || pLow  >= 1) return `bad low price (${low.probability})`;
  if (pHigh == null || pHigh <= 0 || pHigh >= 1) return `bad high price (${high.probability})`;

  const fA = feeFor(low.platform);
  const fB = feeFor(high.platform);
  if (fA > 0.15) return `fee too high on ${low.platform} (${fA})`;
  if (fB > 0.15) return `fee too high on ${high.platform} (${fB})`;

  if (!isFinite(o.roi)) return `invalid roi (${o.roi})`;
  if (o.roi > 50) return `roi too high, likely unreliable (${o.roi}%)`;
  // Signal/divergence pairs carry roi=0 but a non-zero spread; allow them through
  if (o.roi <= 0 && !(o.cashable === false && (o.spread ?? 0) > 0)) return `non-positive roi (${o.roi})`;

  if (!low.platform  || !high.platform)  return 'missing platform name';
  if (!low.url       || !high.url)       return 'missing url';

  return null;
}

export async function GET() {
  try {
    // Prefer the re-priced view (live prices, evaporated pairs removed).
    // Fall back to the discovery snapshot if the re-pricer hasn't run yet.
    let raw: any;
    let repricedAt: number | null    = null;
    let discoveryAt: number | null   = null;

    try {
      const repriced = JSON.parse(fs.readFileSync('/tmp/repriced-opportunities.json', 'utf8'));
      repricedAt  = repriced.repriced_at   ?? null;
      discoveryAt = repriced.discovery_at  ?? null;
      raw = { ...repriced, updatedAt: repriced.repriced_at ?? repriced.discovery_at };
    } catch {
      // Re-pricer hasn't produced output yet — use discovery snapshot directly
      raw         = JSON.parse(fs.readFileSync('/tmp/arbitrage-opportunities.json', 'utf8'));
      discoveryAt = raw.updatedAt ?? null;
    }

    const allOpps: any[] = raw.opportunities ?? [];

    // Market count from markets-raw.json (best-effort)
    let marketsTracked = 0;
    try {
      const mraw = JSON.parse(fs.readFileSync('/tmp/markets-raw.json', 'utf8'));
      marketsTracked =
        (mraw.predictit?.length  ?? 0) +
        (mraw.manifold?.length   ?? 0) +
        (mraw.kalshi?.length     ?? 0) +
        (mraw.polymarket?.length ?? 0);
    } catch {}

    const seen  = new Set<string>();
    const valid: any[] = [];
    let rejected = 0;

    for (const o of allOpps) {
      const reason = isValidOpp(o);
      if (reason) { rejected++; continue; }

      const low  = o.lowMarket;
      const high = o.highMarket;

      const pairKey = stableOppId(low, high);
      if (seen.has(pairKey)) { rejected++; continue; }
      seen.add(pairKey);

      const fA = feeFor(low.platform);
      const fB = feeFor(high.platform);

      // Determine type: signal-only platform → signal; semantic-mismatch → signal; otherwise cashable
      const isSignalOnly =
        SIGNAL_ONLY_PLATFORMS.has(low.platform?.toLowerCase()) ||
        SIGNAL_ONLY_PLATFORMS.has(high.platform?.toLowerCase());

      // Gate 1 (immediate stopgap): mutually-exclusive Kalshi single-stage vs cumulative PM.
      // STAGEOFELIM tickers in the current discovery file were not yet blocked by matcher-v2.
      const isStageMismatch = hasMutuallyExclusiveVsCumulativeMismatch(o);

      // Gate 2: IDF confidence too low for cashable label
      const confTooLow = typeof o.confidence === 'number' && o.confidence < CASHABLE_MIN_CONFIDENCE;

      // Gate 3: executable size too small (computed by enrichArbs in matcher-v2)
      const capUsd     = typeof o.capacityUsd === 'number' ? o.capacityUsd : null;
      const tooSmall   = capUsd !== null && capUsd < CASHABLE_MIN_SIZE_USD;

      const isCashable = !isSignalOnly && !isStageMismatch && !confTooLow && !tooSmall;

      // Expose the specific reason a pair is non-cashable so the detail page can show
      // an accurate "HOW TO OPERATE" section without defaulting to Manifold boilerplate.
      const nonCashableReason: string | null = isCashable ? null
        : isSignalOnly    ? 'play_money'
        : isStageMismatch ? 'stage_mismatch'
        : confTooLow      ? 'low_confidence'
        : tooSmall        ? 'small_capacity'
        : 'no_arb';

      const confidenceNote: string | null = confTooLow && typeof o.confidence === 'number'
        ? `${Math.round(o.confidence * 100)}% (min: ${Math.round(CASHABLE_MIN_CONFIDENCE * 100)}%)`
        : null;

      const capacityNote: string | null = tooSmall && capUsd !== null
        ? `$${Math.round(capUsd)} (min: $${CASHABLE_MIN_SIZE_USD})`
        : null;

      valid.push({
        id: pairKey,
        question:         o.question ?? o.title ?? '—',
        lowMarket: {
          platform:    low.platform,
          probability: low.probability,
          url:         low.url,
          urlVerified: low.urlVerified  ?? false,
          fee:         fA,
          expiresAt:   low.expiresAt   ?? null,
          yesBid:      typeof low.yesBid  === 'number' ? low.yesBid  : null,
          yesAsk:      typeof low.yesAsk  === 'number' ? low.yesAsk  : null,
          // Executable YES-ask ladder (2-5 levels, best price first). Only Kalshi/Polymarket
          // expose a real order book — Manifold (AMM, no discrete book) and PredictIt (no
          // book endpoint) stay null here, never a fabricated ladder.
          depth:       Array.isArray(low.depth) ? low.depth : null,
          capacityUsd: typeof low.capacityUsd === 'number' ? low.capacityUsd : null,
        },
        highMarket: {
          platform:    high.platform,
          probability: high.probability,
          url:         high.url,
          urlVerified: high.urlVerified ?? false,
          fee:         fB,
          expiresAt:   high.expiresAt  ?? null,
          yesBid:      typeof high.yesBid === 'number' ? high.yesBid : null,
          yesAsk:      typeof high.yesAsk === 'number' ? high.yesAsk : null,
          depth:       Array.isArray(high.depth) ? high.depth : null,
          capacityUsd: typeof high.capacityUsd === 'number' ? high.capacityUsd : null,
        },
        spread:           o.spread,
        roi:              isCashable ? o.roi : 0,
        earnPer100:       o.earnPer100  ?? null,
        confidence:       o.confidence,
        category:         o.category   ?? 'unknown',
        type:             isCashable ? 'cashable' : 'signal',
        // Prediction pairs settle once at resolution, never recurring — always null here
        // regardless of what upstream sets, so a future change to agent5-calculator can
        // never leak a fabricated annualized/per-day figure into this API (honest-engine).
        annualizedROI:      null,
        daysToResolution:   o.daysToResolution   ?? null,
        resolutionDate:     o.resolutionDate     ?? null,
        resolutionMismatch: o.resolutionMismatch ?? false,
        settlementType:     o.settlementType     ?? 'one_time',
        confirmReason:        o.confirmReason    ?? null,
        lockupFlag:           o.lockupFlag       ?? null,
        capacityUsd:          capUsd,
        nonCashableReason,
        confidenceNote,
        capacityNote,
      });
    }

    valid.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'cashable' ? -1 : 1;
      if (a.type === 'cashable') return b.roi - a.roi;
      return b.spread - a.spread;  // divergence: sort by price gap desc
    });

    const cashable = valid.filter(o => o.type === 'cashable');
    const bestRoi  = cashable.length > 0 ? cashable[0].roi : null;
    const now      = Date.now();

    // Freshness: two independent clocks
    const repriceAgeMin   = repricedAt  ? Math.round((now - repricedAt)  / 60_000) : null;
    const discoveryAgeMin = discoveryAt ? Math.round((now - discoveryAt) / 60_000) : null;
    const repriceStale    = repriceAgeMin   !== null && repriceAgeMin   >= REPRICE_OVERDUE_MIN;
    const discoveryStale  = discoveryAgeMin !== null && discoveryAgeMin >= DISCOVERY_OVERDUE_MIN;
    const nextDiscoveryAt = nextDiscoveryRunAt(now);

    // Pipeline counts from re-pricer stats (or fall back to discovery stats)
    const repricerStats   = raw.stats ?? {};
    const confirmedCashable      = repricerStats.live_cashable ?? repricerStats.confirmedCashable      ?? cashable.length;
    const totalCashableCandidates = repricerStats.discovery_cashable ?? repricerStats.totalCashableCandidates ?? cashable.length;
    const evaporated             = repricerStats.evaporated ?? 0;
    const inactive               = repricerStats.inactive   ?? 0;
    const pendingVerification    = repricerStats.pendingVerification ?? 0;

    return NextResponse.json({
      valid,
      rejected,
      stats: {
        validCount:               valid.length,
        cashableCount:            cashable.length,
        signalCount:              valid.filter(o => o.type === 'signal').length,
        confirmedCashable,
        totalCashableCandidates,
        evaporated,
        inactive,
        pendingVerification,
        bestRoi,
        marketsTracked,
        platforms:    4,
        updatedAt:    repricedAt ?? discoveryAt,
        pipelineAge:  repricedAt ? Math.round((now - repricedAt) / 1000) : null,
      },
      freshness: {
        pricesAt:       repricedAt,
        discoveryAt,
        nextDiscoveryAt,
        repriceStale,
        discoveryStale,
        repriceAgeMin,
        discoveryAgeMin,
        repriceLabel:   repriceAgeMin   !== null ? `${repriceAgeMin}m AGO`   : null,
        discoveryLabel: discoveryAgeMin !== null
          ? (discoveryAgeMin < 60 ? `${discoveryAgeMin}m AGO` : `${Math.round(discoveryAgeMin / 60)}h AGO`)
          : null,
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
      freshness: {
        pricesAt: null, discoveryAt: null, nextDiscoveryAt: null,
        repriceStale: false, discoveryStale: false,
        repriceAgeMin: null, discoveryAgeMin: null,
        repriceLabel: null, discoveryLabel: null,
      },
    });
  }
}
