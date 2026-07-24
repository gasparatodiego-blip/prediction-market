// Types for lib/rewards-server-filter.js (the .js module owns the filter math).
export interface RewardFilterState {
  venue: 'all' | 'polymarket' | 'kalshi';
  categories: string[];
  minPool: number | null;
  minDepth: number | null;
  maxSpreadCents: number | null;
  maxCompetitionPct: number | null;
  hideThin: boolean;
}
export interface RewardFilterScalars {
  venue: string | undefined;
  category: string | null;
  poolUsd: number | null;
  depthUsd: number | null;
  competitionPct: number | null;
  spreadCents: number | null;
  thin: boolean;
}
export interface RewardFilterRanges {
  poolMax: number;
  depthMax: number;
  spreadMaxCents: number;
  categories: string[];
  venues: string[];
  hasCompetition: boolean;
}
export function filterScalars(m: any): RewardFilterScalars;
export function parseRewardFilters(sp: URLSearchParams | Record<string, string> | null): RewardFilterState;
export function applyRewardFilters<T = any>(markets: T[], f: RewardFilterState): T[];
export function deriveRanges(markets: any[]): RewardFilterRanges;
