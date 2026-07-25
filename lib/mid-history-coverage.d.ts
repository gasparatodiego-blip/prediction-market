// Types for lib/mid-history-coverage.js — the mandated backtest coverage header.

export interface CoverageHeader {
  coveredMarketCount: number | null;
  universeMarketCount: number | null;
  coverageFraction: number | null;   // covered / universe; null when the denominator is unknown
  coveragePct: number | null;
  partial: boolean;                   // covered < universe (unknown → true, fail-honest)
  belowHalf: boolean;                 // fraction < 0.5 (unknown → true, fail-honest)
  representative: boolean;            // only a full-coverage result is representative of the lane
  at: string | null;
  headerLines: string[];             // print VERBATIM before any result
  subsetOnly: string | null;         // the explicit "subscribed subset only" line when below 50%
}

export function coverageHeader(args: {
  coveredMarketCount?: number | null;
  universeMarketCount?: number | null;
  at?: string | null;
}): CoverageHeader;

export const COVERAGE_FULL_THRESHOLD: number;
