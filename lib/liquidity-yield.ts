// lib/liquidity-yield.ts — pure, balance-driven liquidity-reward yield.
//
// SINGLE SOURCE OF TRUTH for "what would I ACTUALLY earn per day if I deploy `balance`
// into this reward market?". Replaces the inflated aggregate-book number (pool × filled%,
// i.e. the whole-book share as if you owned nearly the entire book) that ignored the
// user's balance and the remaining book space.
//
// HONEST-ENGINE CONTRACT
//   - $/day is DILUTED by your own deployment: share = deployed / (Q + deployed). Adding
//     capital shrinks your own marginal share — no "own the book" fantasy.
//   - Deployment is CAPPED at the remaining book space (cap − Q). Capital beyond that
//     `space` sits idle and earns nothing — surfaced calmly, never as an error. When a
//     venue exposes NO cap (e.g. Polymarket, where any liquidity can qualify and simply
//     dilutes), `cap` is absent → space is unbounded → the whole balance deploys and idle
//     is 0. A cap is NEVER fabricated to invent an idle number.
//   - APY is on DEPLOYED capital, never on total balance (idle capital would understate,
//     but the headline yield must reflect the money actually at work).
//   - Missing pool or qualifying liquidity ⇒ unknown:true ⇒ the caller renders "—".
//     Nothing is fabricated; Q is never invented.
//   - apyRaw is returned UNCAPPED; the caller caps/labels it via lib/honest-display
//     (APY_CAP = 200, ">200%/yr · run-rate, not guaranteed"). The cap is not re-implemented
//     here so there is one ceiling for the whole app.

export interface LiquidityYieldInput {
  poolPerDay:          number | null | undefined;   // reward pool $/day
  cap:                 number | null | undefined;    // max qualifying liquidity the band rewards
  qualifyingLiquidity: number | null | undefined;    // Q already qualifying in the book
  balance:             number | null | undefined;    // the user's capital
}

export interface LiquidityYieldResult {
  space:    number;   // max(0, cap − Q) — room you can still qualify into
  deployed: number;   // min(balance, space) — capital actually put to work
  idle:     number;   // max(0, balance − deployed) — balance that does nothing (book full)
  share:    number;   // deployed / (Q + deployed); 0 when the denominator is 0
  dailyUsd: number;   // poolPerDay × share
  apyRaw:   number;   // deployed>0 ? dailyUsd×365/deployed×100 : 0  (UNCAPPED — cap in caller)
  unknown:  boolean;  // true when poolPerDay or qualifyingLiquidity is missing/NaN
}

function fin(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

export function computeLiquidityYield(input: LiquidityYieldInput): LiquidityYieldResult {
  const pool    = input.poolPerDay;
  const Q       = input.qualifyingLiquidity;
  const balance = fin(input.balance) ? Math.max(0, input.balance) : 0;

  // Honest: no pool or no measured qualifying liquidity ⇒ withhold, render "—".
  if (!fin(pool) || !fin(Q)) {
    return { space: 0, deployed: 0, idle: balance, share: 0, dailyUsd: 0, apyRaw: 0, unknown: true };
  }

  // No cap known ⇒ unbounded room: the whole balance deploys and dilutes (idle 0). A cap,
  // when real, limits deployment to (cap − Q) and the remainder is idle.
  const space    = fin(input.cap) ? Math.max(0, input.cap - Q) : Infinity;
  const deployed = Math.min(balance, space);
  const idle     = Math.max(0, balance - deployed);
  const denom    = Q + deployed;
  const share    = denom > 0 ? deployed / denom : 0;
  const dailyUsd = pool * share;
  const apyRaw   = deployed > 0 ? (dailyUsd * 365 / deployed) * 100 : 0;

  // Invariant: with a known pool + Q, the outputs MUST be finite at any balance. `unknown`
  // is reserved strictly for missing inputs — it never flips on magnitude — so the caller's
  // "—" can only ever mean "no data", never a NaN or a silent high-value gate. The finite
  // fallbacks are defensive (unreachable for finite inputs) and keep a real row showing a
  // number rather than degrading to "—".
  return {
    space,
    deployed,
    idle,
    share:    Number.isFinite(share)    ? share    : 0,
    dailyUsd: Number.isFinite(dailyUsd) ? dailyUsd : 0,
    apyRaw:   Number.isFinite(apyRaw)   ? apyRaw   : 0,
    unknown:  false,
  };
}
