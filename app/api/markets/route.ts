import { NextResponse } from 'next/server';
import fs from 'fs';
import { loadBucketsSync, computeBiasScore, type CalibrationBucket } from '@/lib/calibration';

const MANIFOLD_API    = 'https://api.manifold.markets/v0';
const KALSHI_API      = 'https://api.elections.kalshi.com/trade-api/v2';
const PREDICTIT_API   = 'https://www.predictit.org/api/marketdata/all/';
const POLYMARKET_API  = 'https://gamma-api.polymarket.com';
const SMARKETS_API    = 'https://api.smarkets.com/v3/markets/?state=live&limit=50';
const METACULUS_API   = 'https://www.metaculus.com/api2/questions/?limit=50&has_crowd_forecast=true';
const AUGUR_GRAPH_API = 'https://api.thegraph.com/subgraphs/name/augurproject/augur-v2';

const OPINION_MARKETS_API = 'https://opinion.markets/api/markets';

const ODDS_API_KEY    = 'aff711ab10f3f1fba585e30405329c7c';
const ODDS_SPORTS     = [
  'soccer_fifa_world_cup',
  'americanfootball_nfl',
  'baseball_mlb',
  'basketball_nba',
  'tennis_atp_french_open',
];
const ODDS_API_FILE   = '/tmp/odds-api-raw.json';

// ── Types ─────────────────────────────────────────

export interface PanelMarket {
  id: string;
  name: string;
  detail: string;
  probability: number | null; // 0–100
  volume?: number | null;     // total traded USD
  expiresAt?: number | null;  // Unix ms
}

export interface ArbCandidate {
  id: string;
  question: string;
  probability: number;  // 0–100
  platform: 'predictit' | 'manifold' | 'kalshi' | 'polymarket' | 'smarkets' | 'metaculus' | 'augur' | 'oddsapi' | 'opinionmarkets';
  bookmaker?: string;   // for oddsapi: specific bookmaker name (e.g., "Betfair Exchange")
  url?: string;
  volume?: number | null;
  liquidity?: number | null;
  expiresAt?: number | null;
  priceSeenAt?: number | null;
  biasScore?: number | null;   // (prob − historical_hit_rate) / prob; positive = overpriced; null = no data
}

export interface MarketsResponse {
  panels: {
    predictit:      PanelMarket[];
    manifold:       PanelMarket[];
    kalshi:         PanelMarket[];
    polymarket:     PanelMarket[];
    smarkets:       PanelMarket[];
    metaculus:      PanelMarket[];
    augur:          PanelMarket[];
    oddsapi:        PanelMarket[];
    opinionmarkets: PanelMarket[];
  };
  arbCandidates: ArbCandidate[];
}

// ── Helpers ───────────────────────────────────────

function toMs(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    return v < 9_999_999_999 ? v * 1000 : v;
  }
  if (typeof v === 'string') {
    const d = Date.parse(v);
    return isNaN(d) ? null : d;
  }
  return null;
}

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

// ── Odds API helpers ──────────────────────────────

interface BookmakerOdds { bm: string; bmTitle: string; prob: number; }

function oddsApiEventCandidates(events: any[]): ArbCandidate[] {
  const candidates: ArbCandidate[] = [];
  for (const ev of events) {
    const bookmakers: any[] = ev.bookmakers ?? [];
    // Collect implied probs per outcome across all bookmakers
    const outcomeMap: Record<string, BookmakerOdds[]> = {};
    for (const bm of bookmakers) {
      const h2h = (bm.markets ?? []).find((m: any) => m.key === 'h2h');
      if (!h2h) continue;
      for (const outcome of h2h.outcomes ?? []) {
        if (!outcome.price || outcome.price <= 1) continue;
        const prob = (1 / outcome.price) * 100;
        if (!outcomeMap[outcome.name]) outcomeMap[outcome.name] = [];
        outcomeMap[outcome.name].push({ bm: bm.key, bmTitle: bm.title || bm.key, prob });
      }
    }

    // For each outcome, emit one candidate per bookmaker
    for (const [outcomeName, entries] of Object.entries(outcomeMap)) {
      if (entries.length < 2) continue;
      const spread = Math.max(...entries.map(e => e.prob)) - Math.min(...entries.map(e => e.prob));
      if (spread < 2) continue; // only include outcomes with meaningful disagreement
      const expiry = toMs(ev.commence_time);
      for (const entry of entries) {
        candidates.push({
          id:          `odds-${ev.id}-${entry.bm}-${outcomeName.replace(/\s+/g, '_')}`,
          question:    `[${ev.sport_title}] ${ev.home_team} vs ${ev.away_team} — ${outcomeName}`,
          probability: Math.round(entry.prob * 10) / 10,
          platform:    'oddsapi',
          bookmaker:   entry.bmTitle,
          url:         undefined,
          volume:      null,
          liquidity:   null,
          expiresAt:   expiry,
        });
      }
    }
  }
  return candidates;
}

function buildOddsApiPanel(events: any[]): PanelMarket[] {
  const panels: PanelMarket[] = [];
  for (const ev of events) {
    // Pick the bookmaker with most disagreement for the home team outcome
    const bookmakers: any[] = ev.bookmakers ?? [];
    const homeProbs: number[] = [];
    for (const bm of bookmakers) {
      const h2h = (bm.markets ?? []).find((m: any) => m.key === 'h2h');
      const outcome = (h2h?.outcomes ?? []).find((o: any) => o.name === ev.home_team);
      if (outcome?.price > 1) homeProbs.push((1 / outcome.price) * 100);
    }
    if (homeProbs.length === 0) continue;
    const bestProb = Math.round(Math.max(...homeProbs) * 10) / 10;
    const worstProb = Math.round(Math.min(...homeProbs) * 10) / 10;
    const spread = bestProb - worstProb;
    panels.push({
      id:          ev.id,
      name:        `${ev.home_team} vs ${ev.away_team}`,
      detail:      `${ev.sport_title} · ${homeProbs.length} bookmakers · spread ${spread.toFixed(1)}%`,
      probability: Math.round((homeProbs.reduce((a, b) => a + b, 0) / homeProbs.length) * 10) / 10,
      volume:      null,
      expiresAt:   toMs(ev.commence_time),
    });
  }
  return panels
    .sort((a, b) => {
      const sa = parseFloat(a.detail.split('spread ')[1] ?? '0');
      const sb = parseFloat(b.detail.split('spread ')[1] ?? '0');
      return sb - sa;
    })
    .slice(0, 30);
}

// ── Opinion Markets fetch ─────────────────────────

async function fetchOpinionMarkets(): Promise<PanelMarket[]> {
  try {
    const res = await fetch(OPINION_MARKETS_API, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list: any[] = Array.isArray(data) ? data : (data.markets ?? data.data ?? []);
    return list
      .filter((m: any) => m && (m.name || m.title || m.question))
      .slice(0, 20)
      .map((m: any) => {
        const name = m.name ?? m.title ?? m.question ?? '';
        const prob = m.probability ?? m.prob ?? m.yes_price ?? m.price ?? null;
        const probNum = prob != null ? Math.round(parseFloat(String(prob)) * (prob > 1 ? 1 : 100)) : null;
        return {
          id:          String(m.id ?? m.slug ?? name.slice(0, 20)),
          name,
          detail:      m.category ?? m.type ?? 'Opinion Markets',
          probability: probNum != null && probNum >= 1 && probNum <= 99 ? probNum : null,
          volume:      m.volume != null ? parseFloat(String(m.volume)) : null,
          expiresAt:   toMs(m.close_time ?? m.closeTime ?? m.end_date ?? m.endDate),
        };
      });
  } catch { return []; }
}

// ── Load cached Odds API data (written by agent2-fetcher every 5 min) ──

function loadOddsApiEvents(): any[] {
  try {
    const raw  = fs.readFileSync(ODDS_API_FILE, 'utf8');
    const data = JSON.parse(raw);
    const age  = Date.now() - (data.fetchedAt ?? 0);
    if (age > 600_000) return []; // stale > 10 min, trigger fresh fetch below
    return data.events ?? [];
  } catch { return []; }
}

async function fetchOddsApiDirect(): Promise<any[]> {
  const results: any[] = [];
  await Promise.all(
    ODDS_SPORTS.map(sport =>
      fetch(
        `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`,
        { cache: 'no-store' }
      )
        .then(r => r.json())
        .then(d => { if (Array.isArray(d)) results.push(...d); })
        .catch(() => {})
    )
  );
  // Update cache
  try { fs.writeFileSync(ODDS_API_FILE, JSON.stringify({ fetchedAt: Date.now(), events: results }, null, 2)); } catch {}
  return results;
}

// ── Price-staleness tracking ──────────────────────

const PRICES_FILE = '/tmp/arb-prices.json';

type PriceRecord = { p: number; t: number };

function loadPriceSeen(): Record<string, PriceRecord> {
  try { return JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8')); } catch { return {}; }
}

function stampCandidates(candidates: ArbCandidate[]): ArbCandidate[] {
  const seen   = loadPriceSeen();
  const now    = Date.now();
  const update = { ...seen };

  const stamped = candidates.map(c => {
    const key   = `${c.platform}:${c.id}`;
    const prev  = seen[key];
    const changed = !prev || Math.abs(prev.p - c.probability) >= 1;
    if (changed) update[key] = { p: c.probability, t: now };
    return { ...c, priceSeenAt: changed ? now : prev!.t };
  });

  const cutoff = now - 7 * 86_400_000;
  const pruned: Record<string, PriceRecord> = {};
  for (const [k, v] of Object.entries(update)) {
    if (v.t > cutoff) pruned[k] = v;
  }
  try { fs.writeFileSync(PRICES_FILE, JSON.stringify(pruned)); } catch {}

  return stamped;
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
        bookmaker:   o.lowMarket.bookmaker ?? undefined,
        url:         o.lowMarket.url,
        volume:      o.lowMarket.volume    ?? null,
        liquidity:   o.lowMarket.liquidity ?? null,
        expiresAt:   o.lowMarket.expiresAt ?? null,
        _paired: {
          id:          o.highMarket.id,
          question:    o.question,
          probability: o.highMarket.probability,
          platform:    o.highMarket.platform,
          bookmaker:   o.highMarket.bookmaker ?? undefined,
          url:         o.highMarket.url,
          volume:      o.highMarket.volume    ?? null,
          liquidity:   o.highMarket.liquidity ?? null,
          expiresAt:   o.highMarket.expiresAt ?? null,
        },
      }));
    } catch {}
  }
  return null;
}

// ── Route ─────────────────────────────────────────

export async function GET() {

  // Load Odds API events — use cache if fresh, otherwise fetch directly
  let oddsEvents = loadOddsApiEvents();
  if (oddsEvents.length === 0) {
    oddsEvents = await fetchOddsApiDirect();
  }

  // ── Parallel fetches ──────────────────────────────
  const [piRaw, mfRaw, kaRaw, pmRaw, smRaw, mcRaw, agRaw, opinionPanel] = await Promise.all([

    fetch(PREDICTIT_API, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ markets: [] })),

    fetch(`${MANIFOLD_API}/markets?limit=50`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => []),

    fetch(`${KALSHI_API}/markets?limit=100&status=open`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ markets: [] })),

    fetch(`${POLYMARKET_API}/markets?active=true&limit=100`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => []),

    fetch(SMARKETS_API, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ markets: [] })),

    fetch(METACULUS_API, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ results: [] })),

    fetch(AUGUR_GRAPH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{
          markets(first: 50, where: { finalizationTime: null }) {
            id description endTime
            outcomes { id description lastPrice }
          }
        }`,
      }),
      cache: 'no-store',
    }).then(r => r.json()).catch(() => ({ data: { markets: [] } })),

    fetchOpinionMarkets(),
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

  // ── Panels ────────────────────────────────────────

  const predictitPanel: PanelMarket[] = piMarkets.map((m: any) => {
    const top = (m.contracts ?? []).find((c: any) => c.lastTradePrice != null);
    return {
      id:          String(m.id),
      name:        m.name,
      detail:      top?.name && top.name !== 'Yes' ? top.name : `${m.contracts?.length ?? 0} contracts`,
      probability: top ? Math.round(top.lastTradePrice * 100) : null,
      volume:      m.tradedVolume ?? null,
      expiresAt:   toMs(m.end),
    };
  });

  const manifoldPanel: PanelMarket[] = mfMarkets.map((m: any) => ({
    id:          String(m.id),
    name:        m.question,
    detail:      m.outcomeType ?? 'Binary',
    probability: Math.round(m.probability * 100),
    volume:      m.totalLiquidity ?? m.volume ?? null,
    expiresAt:   toMs(m.closeTime),
  }));

  const kalshiPanel: PanelMarket[] = kaMarkets.map((m: any) => ({
    id:          String(m.ticker),
    name:        m.title,
    detail:      'Elections / Politics',
    probability: kalshiPrice(m),
    volume:      m.volume ?? null,
    expiresAt:   toMs(m.expiration_time ?? m.close_time),
  }));

  const polymarketPanel: PanelMarket[] = pmMarkets.map((m: any) => ({
    id:          String(m.id),
    name:        m.question,
    detail:      'Polymarket',
    probability: polymarketPrice(m),
    volume:      m.volume != null ? parseFloat(m.volume) : null,
    expiresAt:   toMs(m.endDateIso ?? m.end_date_iso ?? m.endDate),
  }));

  const smarketsPanel: PanelMarket[] = smMarkets.map((m: any) => ({
    id:          String(m.id),
    name:        m.name,
    detail:      m.market_type ?? 'Smarkets',
    probability: smarketsPrice(m),
    volume:      m.traded_volume ? parseFloat(m.traded_volume) / 100 : null,
    expiresAt:   toMs(m.close_time ?? m.end_date),
  }));

  const metaculusPanel: PanelMarket[] = mcMarkets.map((q: any) => ({
    id:          String(q.id),
    name:        q.title,
    detail:      q.type ?? 'Forecast',
    probability: metaculusProb(q),
    volume:      null,
    expiresAt:   toMs(q.close_time ?? q.resolution_criteria?.end_time),
  }));

  const augurPanel: PanelMarket[] = agMarkets.map((m: any) => ({
    id:          String(m.id),
    name:        m.description,
    detail:      'Augur',
    probability: augurPrice(m),
    volume:      null,
    expiresAt:   toMs(m.endTime),
  }));

  const oddsApiPanel: PanelMarket[] = buildOddsApiPanel(oddsEvents);
  // opinionPanel is already built by fetchOpinionMarkets()

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
          liquidity:   c.bestBuyYesCost != null
                         ? Math.round(c.bestBuyYesCost * 850)
                         : (m.tradedVolume ? Math.round(m.tradedVolume * 0.05) : null),
          expiresAt:   toMs(m.end),
        }))
    ),
    ...mfMarkets.map((m: any) => ({
      id:          `mf-${m.id}`,
      question:    String(m.question),
      probability: Math.round(m.probability * 100),
      platform:    'manifold' as const,
      url:         m.url ?? `https://manifold.markets/${m.slug ?? ''}`,
      volume:      m.totalLiquidity ?? m.volume ?? null,
      liquidity:   m.totalLiquidity != null ? Math.round(m.totalLiquidity) : null,
      expiresAt:   toMs(m.closeTime),
    })),
    ...kaMarkets.map((m: any) => ({
      id:          `ka-${m.ticker}`,
      question:    String(m.title),
      probability: kalshiPrice(m),
      platform:    'kalshi' as const,
      url:         `https://kalshi.com/markets/${m.ticker}`,
      volume:      m.volume ?? null,
      liquidity:   m.open_interest != null
                     ? Math.round(m.open_interest * kalshiPrice(m) / 100)
                     : (m.volume ? Math.round(m.volume * 0.1) : null),
      expiresAt:   toMs(m.expiration_time ?? m.close_time),
    })),
    ...pmMarkets.map((m: any) => ({
      id:          `pm-${m.id}`,
      question:    String(m.question),
      probability: polymarketPrice(m) ?? 50,
      platform:    'polymarket' as const,
      url:         m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
      volume:      m.volume != null ? parseFloat(m.volume) : null,
      liquidity:   m.liquidityNum != null
                     ? Math.round(parseFloat(m.liquidityNum))
                     : (m.liquidity != null ? Math.round(parseFloat(m.liquidity)) : null),
      expiresAt:   toMs(m.endDateIso ?? m.end_date_iso ?? m.endDate),
    })),
    ...smMarkets.map((m: any) => ({
      id:          `sm-${m.id}`,
      question:    String(m.name),
      probability: smarketsPrice(m) ?? 50,
      platform:    'smarkets' as const,
      url:         `https://smarkets.com/event/${m.event_id ?? m.id}`,
      volume:      m.traded_volume ? parseFloat(m.traded_volume) / 100 : null,
      liquidity:   m.traded_volume ? Math.round(parseFloat(m.traded_volume) / 100 * 0.05) : null,
      expiresAt:   toMs(m.close_time ?? m.end_date),
    })),
    ...mcMarkets.map((q: any) => ({
      id:          `mc-${q.id}`,
      question:    String(q.title),
      probability: metaculusProb(q) ?? 50,
      platform:    'metaculus' as const,
      url:         `https://www.metaculus.com/questions/${q.id}`,
      volume:      null,
      liquidity:   null,
      expiresAt:   toMs(q.close_time ?? q.resolution_criteria?.end_time),
    })),
    ...agMarkets.map((m: any) => ({
      id:          `ag-${m.id}`,
      question:    String(m.description),
      probability: augurPrice(m) ?? 50,
      platform:    'augur' as const,
      url:         `https://augur.net`,
      volume:      null,
      liquidity:   null,
      expiresAt:   toMs(m.endTime),
    })),
    // The Odds API: one candidate per (event × bookmaker × outcome)
    ...oddsApiEventCandidates(oddsEvents),
    // Opinion Markets
    ...opinionPanel
      .filter(m => m.probability != null && m.probability > 1 && m.probability < 99)
      .map(m => ({
        id:          `om-${m.id}`,
        question:    m.name,
        probability: m.probability!,
        platform:    'opinionmarkets' as const,
        url:         `https://opinion.markets`,
        volume:      m.volume ?? null,
        liquidity:   null,
        expiresAt:   m.expiresAt ?? null,
      })),
  ];

  // ── Calibration: attach bias scores ──────────────
  // Load synchronously from DB (fast); triggers background refresh if stale (handled by /api/calibration GET)
  const calibBuckets: CalibrationBucket[] = loadBucketsSync();
  const scored = (candidates: ArbCandidate[]) =>
    candidates.map(c => ({
      ...c,
      biasScore: computeBiasScore(c.probability, calibBuckets),
    }));

  const agentArb  = loadAgentArb();
  const stamped   = stampCandidates(agentArb ?? arbCandidates);
  const finalArb  = scored(stamped);

  // Trigger background calibration refresh if DB is empty (first run)
  if (calibBuckets.length === 0) {
    fetch(`http://localhost:${process.env.PORT ?? 3000}/api/calibration`, { method: 'POST' })
      .catch(() => {});
  }

  const body: MarketsResponse = {
    panels: {
      predictit:      predictitPanel,
      manifold:       manifoldPanel,
      kalshi:         kalshiPanel,
      polymarket:     polymarketPanel,
      smarkets:       smarketsPanel,
      metaculus:      metaculusPanel,
      augur:          augurPanel,
      oddsapi:        oddsApiPanel,
      opinionmarkets: opinionPanel,
    },
    arbCandidates: finalArb,
  };

  return NextResponse.json(body);
}
