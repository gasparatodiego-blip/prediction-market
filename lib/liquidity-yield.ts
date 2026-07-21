// lib/liquidity-yield.ts — pure, balance-driven liquidity-reward yield.
//
// SINGLE SOURCE OF TRUTH for "what would I ACTUALLY earn per day if I deploy `balance`
// into this reward market?". Replaces the inflated aggregate-book number (pool × filled%,
// i.e. the whole-book share as if you owned nearly the entire book) that ignored the
// user's balance and the remaining book space.
//
// HONEST-ENGINE CONTRACT
//   - $/day is DILUTED by your own deployment: share = deployed / (competitorDepth + deployed).
//     Adding capital shrinks your own marginal share — no "own the book" fantasy.
//   - competitorDepth is the qualifying liquidity you REALLY compete with. On a two-sided venue
//     (Polymarket) you only earn by provisioning BOTH sides, so it is Qnear + Qopp (the union of
//     both in-band sides) — a thin near side beside a thick far side no longer reads as
//     domination. On a one-sided venue (Qopp omitted) it is just Qnear (unchanged). This is the
//     number the caller must display as "depth" so the shown depth matches the share.
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
  qualifyingLiquidity: number | null | undefined;    // near-side Q already qualifying in the book
  // TWO-SIDED VENUES (Polymarket): opposite-side in-band qualifying depth. When supplied, the
  // dilution denominator is the UNION of both sides (see below). Omit/null on one-sided venues
  // (e.g. Kalshi flat pro-rata) → reduces exactly to the prior one-sided model. Never fabricated:
  // the caller passes it only when the feed actually measures the opposite side.
  qualifyingLiquidityOpposite?: number | null | undefined;
  balance:             number | null | undefined;    // the user's capital
}

export interface LiquidityYieldResult {
  space:           number;   // max(0, cap − Q) — room you can still qualify into
  deployed:        number;   // min(balance, space) — capital actually put to work
  idle:            number;   // max(0, balance − deployed) — balance that does nothing (book full)
  competitorDepth: number;   // the qualifying depth you actually dilute against: near-side Q on a
                             // one-sided venue, or Qnear+Qopp (both sides) on a two-sided venue.
                             // This is the number the caller must SHOW as "depth" so the displayed
                             // depth is consistent with the share below.
  share:           number;   // deployed / (competitorDepth + deployed); 0 when the denom is 0
  dailyUsd:        number;   // poolPerDay × share
  apyRaw:          number;   // deployed>0 ? dailyUsd×365/deployed×100 : 0 (UNCAPPED — cap in caller)
  unknown:         boolean;  // true when poolPerDay or qualifyingLiquidity is missing/NaN
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
    return { space: 0, deployed: 0, idle: balance, competitorDepth: 0, share: 0, dailyUsd: 0, apyRaw: 0, unknown: true };
  }

  // TWO-SIDED DILUTION (Polymarket real mechanic). Polymarket scores a maker on Qmin =
  // max(min(Qbid,Qask), max(Qbid,Qask)/3): you only earn to the extent you provision BOTH
  // sides, so a $1 that could "own" a thin one-sided book cannot: it must also stand up the
  // OTHER side, where the qualifying liquidity is usually different. A rational maker splits
  // capital to equalise its share across both sides; that optimum's achievable (min-side)
  // share is exactly  deployed / (Qnear + Qopp + deployed)  — i.e. dilute against the UNION of
  // both sides' in-band depth, not just the near side. So competitorDepth = Qnear + Qopp.
  //   • Qopp supplied (two-sided venue) → denominator grows → share DROPS on skewed books
  //     (thin near side + thick far side no longer reads as domination). No fabricated haircut:
  //     Qopp is a real measured per-side depth from the feed.
  //   • Qopp absent/null (one-sided venue, e.g. Kalshi) → Qopp = 0 → reduces to Qnear exactly,
  //     the prior model, byte-for-byte.
  const Qopp            = fin(input.qualifyingLiquidityOpposite) ? Math.max(0, input.qualifyingLiquidityOpposite) : 0;
  const competitorDepth = Q + Qopp;

  // No cap known ⇒ unbounded room: the whole balance deploys and dilutes (idle 0). A cap,
  // when real, limits deployment to (cap − Q) and the remainder is idle. Deployment room is a
  // near-side notion (a capped venue is one-sided here → Qopp 0), so `space` still keys off Q.
  const space    = fin(input.cap) ? Math.max(0, input.cap - Q) : Infinity;
  const deployed = Math.min(balance, space);
  const idle     = Math.max(0, balance - deployed);
  const denom    = competitorDepth + deployed;
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
    competitorDepth,
    share:    Number.isFinite(share)    ? share    : 0,
    dailyUsd: Number.isFinite(dailyUsd) ? dailyUsd : 0,
    apyRaw:   Number.isFinite(apyRaw)   ? apyRaw   : 0,
    unknown:  false,
  };
}
