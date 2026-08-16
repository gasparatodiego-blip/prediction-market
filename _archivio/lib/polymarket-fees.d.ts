// Types for lib/polymarket-fees.js (SSOT for Polymarket CLOB v2 taker fees).
// Structural only — the JS module is the source of truth for the math and the honest-engine rules.
//
// Fee model: taker-only (makers pay 0), fee_usd = C·feeRate·p·(1−p), feeRate = base_fee/20000.
// takerFeeFraction* returns fee-as-a-fraction-of-notional = feeRate·(1−p), or null when unknown.
// null ALWAYS means "—": the consumer must not present a confirmed edge computed from a default fee.

/** Live per-market base_fee in bps for one CLOB token, or null on any failure/unknown token. Cached 6h. */
export function getBaseFeeBps(tokenId: string): Promise<number | null>;

/** Taker fee as a fraction of the leg's notional, reading base_fee live. null when unknown. */
export function takerFeeFraction(tokenId: string, price: number): Promise<number | null>;

/** PURE/SYNC: taker fee fraction from a KNOWN base_fee. null when base_fee is null or price ∉ (0,1). */
export function takerFeeFractionFromBps(baseFeeBps: number | null, price: number): number | null;

/** Makers are never charged under CLOB v2 (taker-only). Always 0. */
export const MAKER_FEE: 0;

/** base_fee(bps) → feeRate divisor (20000; conservative, base_fee 1000 → 0.05 = on-chain cap). */
export const BASE_FEE_TO_RATE_DIVISOR: number;
