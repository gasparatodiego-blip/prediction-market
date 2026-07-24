// Types for lib/maker/universe.js (the JS module is the source of truth for the resolution math).
import type { MakerSelection } from './selection'

export interface ResolvedUniverse {
  resolvedMarketIds: string[]
  resolvedMarkets: any[]
  matchedBeforeCap: number
  truncated: boolean
  maxMarkets: number
}

export function resolveMakerUniverse(rawMarkets: any[], selection: Partial<MakerSelection>): ResolvedUniverse
export function dropResolvedRewards<T>(markets: T[] | null | undefined): T[]
export function isResolved(m: any): boolean
