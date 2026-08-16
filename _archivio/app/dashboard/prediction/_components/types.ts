// Shared types for the /dashboard/prediction page and its event-comparator
// components — mirrors the live /api/prediction response shape exactly
// (app/api/prediction/route.ts). Kept in one place so the page and the
// comparator components can never silently drift apart.

export interface Leg {
  platform:    string;
  // null on free tier (server-side redaction) — see lib/paid-gating.ts
  probability: number | null;
  url:         string;
  urlVerified: boolean;
  fee:         number;
  expiresAt:   number | null;
  yesBid?:     number | null;
  yesAsk?:     number | null;
  // Executable YES-ask ladder (best price first), USD size per level.
  // Kalshi/Polymarket only — Manifold/PredictIt never populate this (no book).
  depth?:       DepthLevel[] | null;
  capacityUsd?: number | null;
}

export interface DepthLevel {
  price:   number; // cents, 0-100
  sizeUsd: number;
}

export interface Opportunity {
  id:                  string;
  question:            string;
  lowMarket:           Leg;
  highMarket:          Leg;
  // spread/roi/confidence: null on free tier (server-side redaction)
  spread:              number | null;
  roi:                 number | null;
  earnPer100:          number | null;
  confidence:          number | null;
  category:            string;
  type:                'cashable' | 'signal';
  annualizedROI?:      number | null;
  daysToResolution?:   number | null;
  resolutionDate?:     string | null;
  settlementType?:     string;
  confirmReason?:      string | null;
  lockupFlag?:         string | null;
  capacityUsd?:        number | null;
  nonCashableReason?:  string | null;
  confidenceNote?:     string | null;
  capacityNote?:       string | null;
}

export interface Stats {
  validCount:               number;
  cashableCount:            number;
  signalCount:              number;
  confirmedCashable:        number;
  totalCashableCandidates:  number;
  evaporated?:              number;
  inactive?:                number;
  pendingVerification:      number;
  bestRoi:                  number | null;
  marketsTracked:           number;
  platforms:                number;
  updatedAt:                number | null;
  pipelineAge:              number | null;
}

export interface Freshness {
  pricesAt:        number | null;
  discoveryAt:     number | null;
  nextDiscoveryAt: number | null;
  repriceStale:    boolean;
  discoveryStale:  boolean;
  repriceAgeMin:   number | null;
  discoveryAgeMin: number | null;
  repriceLabel:    string | null;
  discoveryLabel:  string | null;
}

// ── Event comparator (ArbBets-style buckets) ────────────────────────────────

export interface VolumeNative {
  amount: number;
  unit:   string; // 'contracts' | 'mana' | 'usd' | ...
}

export interface EventPlatform {
  platform:       string;
  tier:           'executable' | 'reference';
  // null on free tier (server-side redaction)
  yesPrice:       number | null;
  noPrice:        number | null;
  volumeUsd:      number | null;
  volumeNative:   VolumeNative | null;
  marketUrl:      string | null;
  depthAvailable: boolean;
  legId:          string;
  // Per-venue trading fee (fraction, e.g. 0.07 = 7%) from the route's PLATFORM_FEES
  // table — public, never redacted. `executable` mirrors tier === 'executable'.
  fee?:           number;
  executable?:    boolean;
}

export interface ReferenceMedian {
  yesPrice:      number | null;
  referenceOnly: true;
}

// Fields attached from the pairwise `valid` opportunity for the same two legs,
// when one exists — never recomputed independently (see agent5-calculator.js
// attachMatchedOpportunity). null when the spread doesn't clear the pairwise
// executable threshold.
export interface MatchedOpportunity {
  cashable:           boolean;
  roi:                number;
  spread:             number;
  earnPer100:         number | null;
  resolutionDate:     string | null;
  daysToResolution:   number | null;
  resolutionMismatch: boolean;
  settlementType:     string;
}

export interface LockableEdge {
  yesPlatform:        string;
  yesPrice:           number;
  yesLegId:           string;
  noPlatform:         string;
  noPrice:            number;
  noLegId:            string;
  matchedOpportunity: MatchedOpportunity | null;
}

export interface EventBucket {
  eventKey:        string;
  title:           string;
  category:        string;
  resolutionDate:  string | null;
  platforms:       EventPlatform[];
  referenceMedian: ReferenceMedian;
  lockableEdge:    LockableEdge | null;
}

export interface ApiResponse {
  valid:     Opportunity[];
  events:    EventBucket[];
  rejected:  number;
  stats:     Stats;
  freshness: Freshness;
}
