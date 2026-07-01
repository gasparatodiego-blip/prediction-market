// lib/reward-gating.ts — shared "sane reward market" predicate.
//
// Imported by:
//   app/dashboard/liquidity-rewards/page.tsx (Kalshi + Polymarket reward lists)
//   app/page.tsx                             (landing "live inside" card)
//
// A market that fails this gate (TRAP, SHORT_BURST, THIN_CAP, BELOW_FLOOR,
// ONE_SIDED, or a lopsided WARN price band) must never be presented as a
// confirmed/cashable reward anywhere in the app. This is the single
// implementation of that rule — do not re-derive it elsewhere.

// %/day → THIN_CAP / "THIN BOOK" flag threshold. Single source of truth for
// agent24 (Polymarket) and agent25 (Kalshi), which compute this flag while
// scanning live order books, and for the gate functions below that consume
// the resulting flag. agent24/25 are plain Node scripts (no ts-node in this
// repo) so they mirror this numeric value rather than importing it — keep
// both in sync with this constant if it ever changes.
// 2%/day ≈ 730%/yr — still generous, but rejects the ~4-5%/day thin-book
// artifacts (implying >1500%/yr) that the old 5%/day cap let through.
export const REWARD_SANITY_CAP_PCT = 2.0;

export interface KalshiGatingFlags {
  TRAP:        boolean;
  SHORT_BURST: boolean;
  BELOW_FLOOR: boolean;
  THIN_CAP:    boolean;
  ONE_SIDED:   boolean;
}

export interface KalshiGatingMarket {
  flags:      KalshiGatingFlags;
  last_price: number;
  levels:     Record<string, { aboveMin?: boolean } | undefined>;
}

/** Lopsided last-price band: not TRAP-extreme, but adverse-fill risk is elevated. */
export function kIsWarn(m: KalshiGatingMarket): boolean {
  if (m.flags.TRAP) return false;
  const p = m.last_price;
  return (p >= 0.80 && p <= 0.90) || (p >= 0.10 && p <= 0.20);
}

/** The exact "sane reward market" gate used by the liquidity-rewards dashboard. */
export function isSaneKalshiMarket(m: KalshiGatingMarket, capitalKey: string): boolean {
  return (
    !m.flags.TRAP && !kIsWarn(m) &&
    !m.flags.SHORT_BURST && !m.flags.THIN_CAP && !m.flags.BELOW_FLOOR && !m.flags.ONE_SIDED &&
    !!m.levels[capitalKey]?.aboveMin
  );
}

export interface PolymarketGatingLevel {
  flags: string[];
}

/** A Polymarket reward level is "sane" only when it carries zero dashboard flags. */
export function isSanePolymarketLevel(lv: PolymarketGatingLevel): boolean {
  return lv.flags.length === 0;
}
