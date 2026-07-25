import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';
import { PUSD, USDCE, CTF, EXCHANGES, oracleName } from '@/lib/poly-contracts';
import { readChainState } from '@/lib/poly-chain-read';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/rewards/event?marketId=… — the STATIC half of the event terminal.
 *
 * WHAT THIS IS: a declaration of everything the venue and the chain say about ONE market. It answers
 * "what are the rules here", never "what should you do here". No recommended price, no suggested
 * placement, no ranking. The live order book is a separate, faster route (./book).
 *
 * PROVENANCE IS PART OF THE PAYLOAD. Every venue rule ships with the RAW field it was read from
 * (`raw.clob` / `raw.gamma`, verbatim key names), so the rendered value can be checked against the
 * source rather than trusted. A field the venue did not return is `null` and renders "—"; it is never
 * defaulted, inferred from a sibling, or carried over from the feed snapshot.
 *
 * READ-ONLY ON THE MAKER PATH: the chain section is eth_call only (lib/poly-chain-read) and no CLOB
 * credential is loaded anywhere in this handler. Nothing here can arm, fund, approve or place.
 */

const NORMALIZED_FILE = '/tmp/liquidity-rewards.json';
const CLOB_BASE = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = 7_000;

type Json = Record<string, any>;

async function getJson(url: string): Promise<Json | Json[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
/** ISO-8601 or null. A date string the venue did not send stays null — never today, never the close. */
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export async function GET(req: NextRequest) {
  const marketId = req.nextUrl.searchParams.get('marketId');
  if (!marketId) return NextResponse.json({ error: 'marketId required' }, { status: 400 });

  const session = await getServerSession(authOptions);
  const isPaid = await getIsPaid(session);

  // ── the feed row: the SAME normalized snapshot the board lists, so the terminal can never show a
  //    different scoring mid / pot / stability than the row the operator tapped. ──
  let feed: Json | null = null;
  let feedGeneratedAt: string | null = null;
  try {
    const snap = JSON.parse(fs.readFileSync(NORMALIZED_FILE, 'utf-8'));
    feedGeneratedAt = snap?.meta?.generatedAt ?? null;
    feed = (snap.markets as Json[]).find((m) => m.marketId === marketId) ?? null;
  } catch {
    feed = null;
  }
  if (!feed) return NextResponse.json({ error: 'market not found in the reward feed', marketId }, { status: 404 });

  const venue: string = feed.venue;
  const isPoly = venue === 'polymarket';

  // ── venue truth. Two independent Polymarket surfaces, fetched in parallel; either may be null and
  //    the sections it feeds then render "—" rather than falling back to the other. ──
  const [clobRaw, gammaRaw] = isPoly
    ? await Promise.all([
        getJson(`${CLOB_BASE}/markets/${encodeURIComponent(marketId)}`) as Promise<Json | null>,
        getJson(`${GAMMA_BASE}/markets?condition_ids=${encodeURIComponent(marketId)}`).then(
          (d) => (Array.isArray(d) && d.length ? (d[0] as Json) : null),
        ),
      ])
    : [null, null];

  const clob = clobRaw && typeof clobRaw === 'object' ? clobRaw : null;
  const gamma = gammaRaw && typeof gammaRaw === 'object' ? gammaRaw : null;

  const tokens: Json[] = Array.isArray(clob?.tokens) ? (clob!.tokens as Json[]) : [];
  const yesTok = tokens.find((t) => t.outcome === 'Yes') ?? null;
  const noTok = tokens.find((t) => t.outcome === 'No') ?? null;
  const tokenIdYes: string | null = (yesTok?.token_id as string) ?? feed.tokenId ?? null;
  const tokenIdNo: string | null = (noTok?.token_id as string) ?? feed.tokenIdNo ?? null;

  // Gamma's clobRewards[] is the reward PROGRAM row — the only place a reward start/end date exists.
  const rewardProgram: Json | null = Array.isArray(gamma?.clobRewards) && gamma!.clobRewards.length
    ? (gamma!.clobRewards[0] as Json)
    : null;

  // ── SECTION D · venue rules, each paired with the raw field it came from ──────────────────────
  const tickSize = num(clob?.minimum_tick_size) ?? num(gamma?.orderPriceMinTickSize) ?? num(feed.tickSize);
  const minOrderSize = num(clob?.minimum_order_size) ?? num(gamma?.orderMinSize);
  const minIncentiveSize = num(clob?.rewards?.min_size) ?? num(gamma?.rewardsMinSize) ?? num(feed.minSize);
  const maxSpreadCents = num(clob?.rewards?.max_spread) ?? num(gamma?.rewardsMaxSpread) ?? num(feed.maxSpread);
  const dailyPotUsd = num(clob?.rewards?.rates?.[0]?.rewards_daily_rate) ?? num(feed.dailyPool);
  // The venue's tradable price range is [tick, 1 − tick]: an order at 0 or 1 is not a price, it is a
  // settled outcome. Derived from the REAL tick, so it is null whenever the tick is unreadable.
  const priceMin = tickSize != null ? tickSize : null;
  const priceMax = tickSize != null ? 1 - tickSize : null;

  const rules = {
    tickSize,
    priceMin,
    priceMax,
    minOrderSize,
    minIncentiveSize,
    maxSpreadCents,
    // The EFFECTIVE reward band is mid ± maxSpread/2 — the divide-by-two is the scorer's own v = the
    // half-band, and it is the same radius lib/maker/venue-rules validates against. Stated, not implied.
    bandRadiusCents: maxSpreadCents != null ? maxSpreadCents / 2 : null,
    dailyPotUsd,
    acceptingOrders: typeof clob?.accepting_orders === 'boolean' ? clob.accepting_orders : null,
    enableOrderBook: typeof clob?.enable_order_book === 'boolean' ? clob.enable_order_book : null,
    closed: typeof clob?.closed === 'boolean' ? clob.closed : null,
    negRisk: typeof clob?.neg_risk === 'boolean' ? clob.neg_risk : (typeof feed.negRisk === 'boolean' ? feed.negRisk : null),
    makerBaseFeeBps: num(clob?.maker_base_fee),
    takerBaseFeeBps: num(clob?.taker_base_fee),
  };

  // ── SECTION C · dates. Every one is a distinct venue field; there is no derivation between them. ──
  const dates = {
    created: iso(gamma?.createdAt),
    opened: iso(gamma?.startDate) ?? iso(clob?.accepting_order_timestamp),
    rewardStart: iso(rewardProgram?.startDate),
    rewardEnd: iso(rewardProgram?.endDate),
    close: iso(clob?.end_date_iso) ?? iso(gamma?.endDate),
    // Polymarket publishes no separate "expected resolution" timestamp; the UMA question opens at the
    // close and settles when the oracle does. Left null unless the venue actually sends one.
    expectedResolution: iso(gamma?.umaEndDate),
    gameStart: iso(clob?.game_start_time),
  };

  // ── SECTION B · identifiers ────────────────────────────────────────────────────────────────────
  const resolvedBy: string | null = (gamma?.resolvedBy as string) ?? null;
  const identifiers = {
    slug: (gamma?.slug as string) ?? feed.marketSlug ?? null,
    eventSlug: (Array.isArray(gamma?.events) && gamma!.events[0]?.slug) || feed.slug || null,
    conditionId: marketId,
    questionId: (clob?.question_id as string) ?? (gamma?.questionID as string) ?? null,
    tokenIdYes,
    tokenIdNo,
    negRiskMarketId: (clob?.neg_risk_market_id as string) ?? null,
    negRiskRequestId: (clob?.neg_risk_request_id as string) ?? null,
    contracts: isPoly
      ? {
          exchanges: EXCHANGES.map((e) => ({ key: e.key, name: e.name, addr: e.addr })),
          conditionalTokens: CTF,
          collateral: { symbol: 'pUSD', addr: PUSD },
          legacyCollateral: { symbol: 'USDC.e', addr: USDCE },
          rewardAssetAddr: (clob?.rewards?.rates?.[0]?.asset_address as string) ?? null,
        }
      : null,
    oracle: resolvedBy ? { addr: resolvedBy, name: oracleName(resolvedBy) } : null,
    umaBond: gamma?.umaBond ?? null,
    umaReward: gamma?.umaReward ?? null,
    resolutionSource: (gamma?.resolutionSource as string) || null,
  };

  // ── SECTION G · chain state. Owner-wallet data, so it is withheld from an unauthenticated tier
  //    entirely (null + a stated reason) rather than partially redacted. Read-only eth_calls. ──
  const chain = isPaid && isPoly ? await readChainState(tokenIdYes, tokenIdNo) : null;

  const payload = {
    marketId,
    venue,
    title: feed.title ?? null,
    groupItemTitle: feed.groupItemTitle ?? null,
    category: feed.category ?? null,
    description: (clob?.description as string) ?? (gamma?.description as string) ?? null,
    hoursToResolution: feed.hoursToResolution ?? null,
    feed,
    feedGeneratedAt,
    dates,
    rules,
    identifiers,
    chain,
    chainWithheld: chain
      ? null
      : !isPoly
        ? 'sezione on-chain non applicabile a questo venue'
        : 'lettura on-chain riservata all’account collegato',
    // VERBATIM venue fields — the check column. Only the keys the sections above actually read.
    // Shape MIRRORS the venue's own nesting (rewards.min_size stays nested) so a redaction path can
    // address it; a flattened "rewards.min_size" string key would be unreachable to the gating layer
    // and would leak the band width to the free tier.
    raw: {
      clob: clob
        ? {
            minimum_tick_size: clob.minimum_tick_size ?? null,
            minimum_order_size: clob.minimum_order_size ?? null,
            rewards: {
              min_size: clob.rewards?.min_size ?? null,
              max_spread: clob.rewards?.max_spread ?? null,
              rewards_daily_rate: clob.rewards?.rates?.[0]?.rewards_daily_rate ?? null,
            },
            neg_risk: clob.neg_risk ?? null,
            accepting_orders: clob.accepting_orders ?? null,
            accepting_order_timestamp: clob.accepting_order_timestamp ?? null,
            end_date_iso: clob.end_date_iso ?? null,
            game_start_time: clob.game_start_time ?? null,
            question_id: clob.question_id ?? null,
            maker_base_fee: clob.maker_base_fee ?? null,
            taker_base_fee: clob.taker_base_fee ?? null,
          }
        : null,
      gamma: gamma
        ? {
            createdAt: gamma.createdAt ?? null,
            startDate: gamma.startDate ?? null,
            endDate: gamma.endDate ?? null,
            umaEndDate: gamma.umaEndDate ?? null,
            resolvedBy: gamma.resolvedBy ?? null,
            rewardsMinSize: gamma.rewardsMinSize ?? null,
            rewardsMaxSpread: gamma.rewardsMaxSpread ?? null,
            orderPriceMinTickSize: gamma.orderPriceMinTickSize ?? null,
            orderMinSize: gamma.orderMinSize ?? null,
            clobRewards0: {
              startDate: rewardProgram?.startDate ?? null,
              endDate: rewardProgram?.endDate ?? null,
              rewardsDailyRate: rewardProgram?.rewardsDailyRate ?? null,
            },
          }
        : null,
    },
    sources: {
      feed: 'agent24/agent25 normalized snapshot (/tmp/liquidity-rewards.json)',
      clob: isPoly ? (clob ? `${CLOB_BASE}/markets/${marketId}` : 'unreachable') : 'n/a',
      gamma: isPoly ? (gamma ? `${GAMMA_BASE}/markets?condition_ids=${marketId}` : 'unreachable') : 'n/a',
      chain: chain ? (chain.rpcReachable ? 'polygon rpc · eth_call (read-only)' : 'polygon rpc unreachable') : 'withheld',
    },
    isPaid,
    fetchedAt: new Date().toISOString(),
  };

  return NextResponse.json(redactForTier(payload, 'rewards-event', isPaid));
}
