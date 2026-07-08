// carry.ts — shared types + verdict logic for the cash-and-carry list and the
// carry order (operation) page, so both classify a contract identically (single
// source of truth for the cashable/speculative verdict — honest-engine).

import { type EdgeChipVariant } from '@/app/components/ui/EdgeChip';

// Derived basis/annualized/capacity fields are null on free tier (server-side
// redaction, lib/paid-gating.ts). Raw spot/future/bid/ask prices, volume, fee,
// expiry, and descriptive fields stay real for everyone — see REDACTION_MAP.carry.
export interface Contract {
  asset:                   string;
  exchange:                string;
  venueKey:                string;
  contract:                string;
  expiry:                  string;
  daysToExpiry:            number;
  spot:                    number;
  future:                  number;
  futureLast:              number | null;
  spotBid:                 number | null;
  spotAsk:                 number | null;
  futureBid:               number | null;
  futureAsk:               number | null;
  indicativeBasisPct:      number | null;
  executableBasisPct:      number | null;
  basis:                   number | null;
  grossAnnualized:         number | null;
  grossAnnualizedExec:     number | null;
  fee:                     number;
  netAnnualizedIndicative: number | null;
  netAnnualizedExecutable: number | null;
  netAnnualized:           number | null;
  vol24Usd:                number;
  oiUsd:                   number | null;
  capacityUsd:             number | null;
  capacitySource:          'book' | 'proxy';
  tier:                    string;
  thinFlag:                boolean;
  coinMargined:            boolean;
  coinMarginedNote:        string | null;
  bidSpreadPct:            number | null;
  // prose headline embeds the exact netAnnualizedExecutable % — redacted
  // together with the numeric fields (server-side, lib/paid-gating.ts)
  verdict:                 string | null;
}

// Real executable book depth (within the fetcher's slip band) at/above this size
// is a genuine fill guarantee → cashable. Below it, a book-depth row stays
// speculative.
export const CASHABLE_MIN_DEPTH_USD = 100_000;

// Honest liquidity gate. Capacity provenance decides which signal we trust:
//  • 'book'  → capacityUsd IS measured order-book depth we can fill into. A row is
//    cashable when that real depth clears the floor, REGARDLESS of 24h turnover
//    (turnover ≠ resting depth). A thin real book (< floor) stays speculative.
//  • 'proxy' → no real book-walk; the vol/OI turnover tier is the best liquidity
//    signal we have, so keep the turnover thinFlag gate.
// Coin-margined return drifts with spot — never a clean locked-USD cashable.
export function chipVariant(c: Contract): EdgeChipVariant {
  if (c.executableBasisPct == null) return 'signal'; // redacted — don't overclaim
  if (c.executableBasisPct <= 0) return 'signal';
  if (c.coinMargined) return 'speculative';
  if (c.capacitySource === 'book') {
    return (c.capacityUsd ?? 0) >= CASHABLE_MIN_DEPTH_USD ? 'cashable' : 'speculative';
  }
  return c.thinFlag ? 'speculative' : 'cashable';
}

// Human-readable reason a row is NOT cashable — used by the operation page to show
// an honest note consistent with the verdict above. Returns null for cashable rows.
export function nonCashableReason(c: Contract): string | null {
  if (chipVariant(c) !== 'speculative') return null;
  if (c.coinMargined) {
    return 'Coin-settled — P&L is paid in the coin, so your USD return drifts with spot even if the basis holds. Not a locked-USD trade.';
  }
  if (c.capacitySource === 'book') {
    return 'The measured order-book depth for this contract is below the cashable threshold — a fill at meaningful size would move the basis. Size down and scale in.';
  }
  return 'Liquidity here is inferred from 24h volume / open interest, not a live order-book walk, and is below the deep tier — the shown capacity may not fill without slippage. Treat as a signal, not a locked fill.';
}
