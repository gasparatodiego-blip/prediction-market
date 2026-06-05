import { NextResponse } from 'next/server';
import fs from 'fs';

const MANIFOLD_API    = 'https://api.manifold.markets/v0';
const KALSHI_API      = 'https://api.elections.kalshi.com/trade-api/v2';
const PREDICTIT_API   = 'https://www.predictit.org/api/marketdata/all/';
const POLYMARKET_API  = 'https://gamma-api.polymarket.com';
const SMARKETS_API    = 'https://api.smarkets.com/v3/markets/?state=live&limit=50';
const METACULUS_API   = 'https://www.metaculus.com/api2/questions/?limit=50&has_crowd_forecast=true';
const AUGUR_GRAPH_API = 'https://api.thegraph.com/subgraphs/name/augurproject/augur-v2';
const BETFAIR_API     = 'https://api.betfair.com/exchange/betting/rest/v1.0';

// ── Types ─────────────────────────────────────────

export interface PanelMarket {
  id: string;
  name: string;
  detail: string;
  probability: number | null; // 0–100
  volume?: number | null;     // USD
}

export interface ArbCandidate {
  id: string;
  question: string;
  probability: number; // 0–100
  platform: 'predictit' | 'manifold' | 'kalshi' | 'polymarket' | 'smarkets' | 'metaculus' | 'augur' | 'betfair';
  url?: string;
  volume?: number | null; // USD
}

export interface MarketsResponse {
  panels: {
    predictit:  PanelMarket[];
    manifold:   PanelMarket[];
    kalshi:     PanelMarket[];
    polymarket: PanelMarket[];
    smarkets:   PanelMarket[];
    metaculus:  PanelMarket[];
    augur:      PanelMarket[];
    betfair:    PanelMarket[];
  };
  arbCandidates: ArbCandidate[];
}

// ── Helpers ───────────────────────────────────────

function kalshiPrice(m: any): number {
  const bid = parseFloat(m.yes_bid_dollars || '0');
  const ask = parseFloat(m.yes_ask_dollars || '0');
  if (bid > 0 && ask > 0) return Math.round(((bid + ask) / 2) * 100);
  return Math.round((ask || bid) * 100);
}

function polymarketPrice(m: any): number | null {
  try {
    const prices = typeof m.outcomePrices === 'string'
      ? JSON.parse(m.outcomePrices)
      : m.outcomePrices;
    if (Array.isArray(prices) && prices[0]) {
      const p = parseFloat(prices[0]);
      if (p > 0) return Math.round(p * 100);
    }
  } catch {}
  const ltp = parseFloat(m.lastTradePrice || '0');
  return ltp > 0 ? Math.round(ltp * 100) : null;
}

function smarketsPrice(market: any): number | null {
  const contracts: any[] = market.contracts ?? [];
  if (contracts.length === 0) return null;
  const first = contracts[0];
  const raw = first?.last_price ?? first?.best_ask_price ?? first?.best_bid_price;
  if (raw == null) return null;
  const val = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (val <= 0) return null;
  return Math.round(val / 100);
}

function metaculusProb(q: any): number | null {
  const cp = q.community_prediction;
  if (!cp) return null;
  const raw = cp.q2 ?? cp.full?.q2;
  if (raw == null || raw <= 0) return null;
  return Math.round(raw * 100);
}

function augurPrice(market: any): number | null {
  const outcomes: any[] = market.outcomes ?? [];
  const yes = outcomes.find((o: any) =>
    (o.description ?? '').toLowerCase() === 'yes' ||
    (o.value ?? '').toLowerCase() === 'yes'
  ) ?? outcomes[0];
  if (!yes) return null;
  const raw = parseFloat(yes.lastPrice ?? yes.price ?? '0');
  if (raw <= 0) return null;
  return Math.round(raw * 100);
}

// Betfair: convert decimal odds to probability, extract from best available price
function betfairPrice(runner: any): number | null {
  const ex = runner?.ex;
  const avail = ex?.availableToBack ?? ex?.availableToLay ?? [];
  if (!avail.length) return null;
  const price = avail[0]?.price;
  if (!price || price <= 1) return null;
  return Math.round((1 / price) * 100);
}

// ── Agent pipeline cache ──────────────────────────

const UI_DATA_FILE = '/tmp/ui-data.json';
const ARB_FILE     = '/tmp/arbitrage-opportunities.json';

function loadAgentArb(): ArbCandidate[] | null {
  for (const f of [UI_DATA_FILE, ARB_FILE]) {
    try {
      const raw  = fs.readFileSync(f, 'utf8');
      const data = JSON.parse(raw);
      const age  = Date.now() - (data.refreshedAt ?? data.updatedAt ?? 0);
      if (age > 120_000) continue;

      const opps: any[] = data.opportunities ?? [];
      if (opps.length === 0) continue;
      return opps.map((o: any) => ({
        id:          o.lowMarket.id,
        question:    o.question,
        probability: o.lowMarket.probability,
        platform:    o.lowMarket.platform,
        url:         o.lowMarket.url,
        volume:      o.lowMarket.volume ?? null,
        _paired: {
          id:          o.highMarket.id,
          question:    o.question,
          probability: o.highMarket.probability,
          platform:    o.highMarket.platform,
          url:         o.highMarket.url,
          volume:      o.highMarket.volume ?? null,
        },
      }));
    } catch {}
  }
  return null;
}

// ── Route ─────────────────────────────────────────

export async function GET() {

  // ── Betfair auth headers (requires env vars) ──
  const betfairHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  const bfApiKey = process.env.BETFAIR_API_KEY;
  const bfSession = process.env.BETFAIR_SESSION_TOKEN;
  if (bfApiKey)  betfairHeaders['X-Application'] = bfApiKey;
  if (bfSession) betfairHeaders['X-Authentication'] = bfSession;
  const betfairEnabled = !!(bfApiKey && bfSession);

  // ── Parallel fetches ──────────────────────────────
  const [piRaw, mfRaw, kaRaw, pmRaw, smRaw, mcRaw, agRaw, bfRaw] = await Promise.all([
    // PredictIt
    fetch(PREDICTIT_API, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ markets: [] })),

    // Manifold — BINARY markets with probability
    fetch(`${MANIFOLD_API}/markets?limit=50`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => []),

    // Kalshi Elections
    fetch(`${KALSHI_API}/markets?limit=100&status=open`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ markets: [] })),

    // Polymarket — active markets sorted by volume
    fetch(`${POLYMARKET_API}/markets?active=true&limit=100`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => []),

    // Smarkets — live markets
    fetch(SMARKETS_API, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ markets: [] })),

    // Metaculus — questions with crowd forecasts
    fetch(METACULUS_API, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ results: [] })),

    // Augur v2 — open markets via The Graph
    fetch(AUGUR_GRAPH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{
          markets(first: 50, where: { finalizationTime: null }) {
            id
            description
            outcomes {
              id
              description
              lastPrice
            }
          }
        }`,
      }),
      cache: 'no-store',
    }).then(r => r.json()).catch(() => ({ data: { markets: [] } })),

    // Betfair Exchange — horse racing, football, politics
    betfairEnabled
      ? fetch(`${BETFAIR_API}/listMarketCatalogue/`, {
          method: 'POST',
          headers: betfairHeaders,
          body: JSON.stringify({
            filter: {
              eventTypeIds: ['1', '2', '26305'],  // football, horse racing, politics
              marketCountries: ['GB', 'US'],
              marketTypeCodes: ['MATCH_ODDS', 'WINNER', 'NEXT_GOAL'],
              inPlayOnly: false,
            },
            marketProjection: ['MARKET_NAME', 'EVENT', 'RUNNER_DESCRIPTION'],
            sort: 'MAXIMUM_TRADED',
            maxResults: '50',
          }),
          cache: 'no-store',
        }).then(r => r.json()).catch(() => [])
      : Promise.resolve([]),
  ]);

  // ── Normalise ─────────────────────────────────────

  const piAllMarkets: any[] = piRaw.markets ?? [];
  const piMarkets:    any[] = piAllMarkets.slice(0, 20);

  const mfMarkets: any[] = (Array.isArray(mfRaw) ? mfRaw : [])
    .filter((m: any) => m.outcomeType === 'BINARY' && m.probability != null)
    .slice(0, 20);

  const kaMarkets: any[] = ((kaRaw.markets ?? []) as any[])
    .filter((m: any) => {
      const bid = parseFloat(m.yes_bid_dollars || '0');
      const ask = parseFloat(m.yes_ask_dollars || '0');
      return bid > 0 || ask > 0;
    })
    .slice(0, 60);

  const pmMarkets: any[] = (Array.isArray(pmRaw) ? pmRaw : [])
    .filter((m: any) => {
      const p = polymarketPrice(m);
      return p !== null && p > 3 && p < 97;
    })
    .slice(0, 30);

  const smMarkets: any[] = ((smRaw.markets ?? []) as any[])
    .filter((m: any) => smarketsPrice(m) !== null)
    .slice(0, 20);

  const mcMarkets: any[] = ((mcRaw.results ?? []) as any[])
    .filter((q: any) => metaculusProb(q) !== null)
    .slice(0, 20);

  const agMarkets: any[] = ((agRaw?.data?.markets ?? []) as any[])
    .filter((m: any) => augurPrice(m) !== null)
    .slice(0, 20);

  // Betfair: each market catalogue item has runners; show each runner as a market entry
  const bfCatalogue: any[] = Array.isArray(bfRaw) ? bfRaw.slice(0, 20) : [];

  // ── Panels ────────────────────────────────────────

  const predictitPanel: PanelMarket[] = piMarkets.map((m: any) => {
    const top = (m.contracts ?? []).find((c: any) => c.lastTradePrice != null);
    const volume = m.tradedVolume ?? null;
    return {
      id:          String(m.id),
      name:        m.name,
      detail:      top?.name && top.name !== 'Yes' ? top.name : `${m.contracts?.length ?? 0} contracts`,
      probability: top ? Math.round(top.lastTradePrice * 100) : null,
      volume,
    };
  });

  const manifoldPanel: PanelMarket[] = mfMarkets.map((m: any) => ({
    id:          String(m.id),
    name:        m.question,
    detail:      m.outcomeType ?? 'Binary',
    probability: Math.round(m.probability * 100),
    volume:      m.totalLiquidity ?? m.volume ?? null,
  }));

  const kalshiPanel: PanelMarket[] = kaMarkets.map((m: any) => ({
    id:          String(m.ticker),
    name:        m.title,
    detail:      'Elections / Politics',
    probability: kalshiPrice(m),
    volume:      m.volume ?? null,
  }));

  const polymarketPanel: PanelMarket[] = pmMarkets.map((m: any) => ({
    id:          String(m.id),
    name:        m.question,
    detail:      'Polymarket',
    probability: polymarketPrice(m),
    volume:      m.volume != null ? parseFloat(m.volume) : null,
  }));

  const smarketsPanel: PanelMarket[] = smMarkets.map((m: any) => ({
    id:          String(m.id),
    name:        m.name,
    detail:      m.market_type ?? 'Smarkets',
    probability: smarketsPrice(m),
    volume:      m.traded_volume ? parseFloat(m.traded_volume) / 100 : null,
  }));

  const metaculusPanel: PanelMarket[] = mcMarkets.map((q: any) => ({
    id:          String(q.id),
    name:        q.title,
    detail:      q.type ?? 'Forecast',
    probability: metaculusProb(q),
    volume:      null,
  }));

  const augurPanel: PanelMarket[] = agMarkets.map((m: any) => ({
    id:          String(m.id),
    name:        m.description,
    detail:      'Augur',
    probability: augurPrice(m),
    volume:      null,
  }));

  // Betfair: one panel entry per market (showing best runner's implied probability)
  const betfairPanel: PanelMarket[] = bfCatalogue.flatMap((cat: any) => {
    const runners: any[] = cat.runners ?? [];
    return runners.slice(0, 2).map((r: any) => ({
      id:          `${cat.marketId}-${r.selectionId}`,
      name:        `${cat.marketName ?? cat.event?.name ?? 'Market'}: ${r.runnerName ?? r.description ?? ''}`,
      detail:      cat.event?.name ?? 'Betfair Exchange',
      probability: betfairPrice(r),
      volume:      cat.totalMatched ?? null,
    })).filter(pm => pm.probability !== null);
  }).slice(0, 20);

  // ── Arb candidates ────────────────────────────────

  const arbCandidates: ArbCandidate[] = [
    ...piAllMarkets.flatMap((m: any) =>
      (m.contracts ?? [])
        .filter((c: any) => c.lastTradePrice != null && c.lastTradePrice > 0)
        .map((c: any) => ({
          id:          `pi-${m.id}-${c.id}`,
          question:    c.name && c.name !== 'Yes'
                         ? `${m.name} — ${c.name}`
                         : String(m.name),
          probability: Math.round(c.lastTradePrice * 100),
          platform:    'predictit' as const,
          url:         `https://www.predictit.org/markets/detail/${m.id}`,
          volume:      m.tradedVolume ?? null,
        }))
    ),
    ...mfMarkets.map((m: any) => ({
      id:          `mf-${m.id}`,
      question:    String(m.question),
      probability: Math.round(m.probability * 100),
      platform:    'manifold' as const,
      url:         m.url ?? `https://manifold.markets/${m.slug ?? ''}`,
      volume:      m.totalLiquidity ?? m.volume ?? null,
    })),
    ...kaMarkets.map((m: any) => ({
      id:          `ka-${m.ticker}`,
      question:    String(m.title),
      probability: kalshiPrice(m),
      platform:    'kalshi' as const,
      url:         `https://kalshi.com/markets/${m.ticker}`,
      volume:      m.volume ?? null,
    })),
    ...pmMarkets.map((m: any) => ({
      id:          `pm-${m.id}`,
      question:    String(m.question),
      probability: polymarketPrice(m) ?? 50,
      platform:    'polymarket' as const,
      url:         m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
      volume:      m.volume != null ? parseFloat(m.volume) : null,
    })),
    ...smMarkets.map((m: any) => ({
      id:          `sm-${m.id}`,
      question:    String(m.name),
      probability: smarketsPrice(m) ?? 50,
      platform:    'smarkets' as const,
      url:         `https://smarkets.com/event/${m.event_id ?? m.id}`,
      volume:      m.traded_volume ? parseFloat(m.traded_volume) / 100 : null,
    })),
    ...mcMarkets.map((q: any) => ({
      id:          `mc-${q.id}`,
      question:    String(q.title),
      probability: metaculusProb(q) ?? 50,
      platform:    'metaculus' as const,
      url:         `https://www.metaculus.com/questions/${q.id}`,
      volume:      null,
    })),
    ...agMarkets.map((m: any) => ({
      id:          `ag-${m.id}`,
      question:    String(m.description),
      probability: augurPrice(m) ?? 50,
      platform:    'augur' as const,
      url:         `https://augur.net`,
      volume:      null,
    })),
    ...bfCatalogue.flatMap((cat: any) =>
      (cat.runners ?? []).slice(0, 2)
        .filter((r: any) => betfairPrice(r) !== null)
        .map((r: any) => ({
          id:          `bf-${cat.marketId}-${r.selectionId}`,
          question:    `${cat.marketName ?? cat.event?.name ?? 'Market'}: ${r.runnerName ?? r.description ?? ''}`,
          probability: betfairPrice(r)!,
          platform:    'betfair' as const,
          url:         `https://www.betfair.com/exchange/plus/market/${cat.marketId}`,
          volume:      cat.totalMatched ?? null,
        }))
    ),
  ];

  // Prefer agent-pipeline arb candidates when fresh
  const agentArb = loadAgentArb();
  const finalArb = agentArb ?? arbCandidates;

  const body: MarketsResponse = {
    panels: {
      predictit:  predictitPanel,
      manifold:   manifoldPanel,
      kalshi:     kalshiPanel,
      polymarket: polymarketPanel,
      smarkets:   smarketsPanel,
      metaculus:  metaculusPanel,
      augur:      augurPanel,
      betfair:    betfairPanel,
    },
    arbCandidates: finalArb,
  };

  return NextResponse.json(body);
}
