import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const MANIFOLD_API   = 'https://api.manifold.markets/v0';
const KALSHI_API     = 'https://api.elections.kalshi.com/trade-api/v2';
const PREDICTIT_API  = 'https://www.predictit.org/api/marketdata/all/';
const POLYMARKET_API = 'https://gamma-api.polymarket.com';

// ── Types ─────────────────────────────────────────

export interface PanelMarket {
  id: string;
  name: string;
  detail: string;
  probability: number | null; // 0–100
}

export interface ArbCandidate {
  id: string;
  question: string;
  probability: number; // 0–100
  platform: 'predictit' | 'manifold' | 'kalshi' | 'polymarket';
  url?: string;
}

export interface MarketsResponse {
  panels: {
    predictit:  PanelMarket[];
    manifold:   PanelMarket[];
    kalshi:     PanelMarket[];
    polymarket: PanelMarket[];
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
  // Try outcomePrices first (YES is index 0)
  try {
    const prices = typeof m.outcomePrices === 'string'
      ? JSON.parse(m.outcomePrices)
      : m.outcomePrices;
    if (Array.isArray(prices) && prices[0]) {
      const p = parseFloat(prices[0]);
      if (p > 0) return Math.round(p * 100);
    }
  } catch {}
  // Fallback to lastTradePrice
  const ltp = parseFloat(m.lastTradePrice || '0');
  return ltp > 0 ? Math.round(ltp * 100) : null;
}

// ── Agent pipeline cache ──────────────────────────

const UI_DATA_FILE = '/tmp/ui-data.json';
const ARB_FILE     = '/tmp/arbitrage-opportunities.json';

function loadAgentArb(): ArbCandidate[] | null {
  // Prefer the UI-updater confirmed snapshot, fall back to raw calculator output
  for (const f of [UI_DATA_FILE, ARB_FILE]) {
    try {
      const raw  = fs.readFileSync(f, 'utf8');
      const data = JSON.parse(raw);
      const age  = Date.now() - (data.refreshedAt ?? data.updatedAt ?? 0);
      if (age > 120_000) continue; // stale

      const opps: any[] = data.opportunities ?? [];
      if (opps.length === 0) continue; // fall back to live matching
      return opps.map((o: any) => ({
        id:          o.lowMarket.id,
        question:    o.question,
        probability: o.lowMarket.probability,
        platform:    o.lowMarket.platform,
        url:         o.lowMarket.url,
        _paired: {
          id:          o.highMarket.id,
          question:    o.question,
          probability: o.highMarket.probability,
          platform:    o.highMarket.platform,
          url:         o.highMarket.url,
        },
      }));
    } catch {}
  }
  return null;
}

// ── Route ─────────────────────────────────────────

export async function GET() {

  // ── Parallel fetches ──────────────────────────────
  const [piRaw, mfRaw, kaRaw, pmRaw] = await Promise.all([
    // PredictIt — lastTradePrice is 0–1 range
    fetch(PREDICTIT_API, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ markets: [] })),

    // Manifold — BINARY markets with probability
    fetch(`${MANIFOLD_API}/markets?limit=50`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => []),

    // Kalshi — direct markets list, filter by ask price
    fetch(`${KALSHI_API}/markets?limit=100&status=open`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ markets: [] })),

    // Polymarket — active markets sorted by volume
    fetch(`${POLYMARKET_API}/markets?active=true&limit=100`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => []),
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

  // ── Panels ────────────────────────────────────────

  const predictitPanel: PanelMarket[] = piMarkets.map((m: any) => {
    const top = (m.contracts ?? []).find((c: any) => c.lastTradePrice != null);
    return {
      id:          String(m.id),
      name:        m.name,
      detail:      top?.name && top.name !== 'Yes' ? top.name : `${m.contracts?.length ?? 0} contracts`,
      probability: top ? Math.round(top.lastTradePrice * 100) : null,
    };
  });

  const manifoldPanel: PanelMarket[] = mfMarkets.map((m: any) => ({
    id:          String(m.id),
    name:        m.question,
    detail:      m.outcomeType ?? 'Binary',
    probability: Math.round(m.probability * 100),
  }));

  const kalshiPanel: PanelMarket[] = kaMarkets.map((m: any) => ({
    id:          String(m.ticker),
    name:        m.title,
    detail:      'Elections / Politics',
    probability: kalshiPrice(m),
  }));

  const polymarketPanel: PanelMarket[] = pmMarkets.map((m: any) => ({
    id:          String(m.id),
    name:        m.question,
    detail:      'Polymarket',
    probability: polymarketPrice(m),
  }));

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
        }))
    ),
    ...mfMarkets.map((m: any) => ({
      id:          `mf-${m.id}`,
      question:    String(m.question),
      probability: Math.round(m.probability * 100),
      platform:    'manifold' as const,
      url:         m.url ?? `https://manifold.markets/${m.slug ?? ''}`,
    })),
    ...kaMarkets.map((m: any) => ({
      id:          `ka-${m.ticker}`,
      question:    String(m.title),
      probability: kalshiPrice(m),
      platform:    'kalshi' as const,
      url:         `https://kalshi.com/markets/${m.ticker}`,
    })),
    ...pmMarkets.map((m: any) => ({
      id:          `pm-${m.id}`,
      question:    String(m.question),
      probability: polymarketPrice(m) ?? 50,
      platform:    'polymarket' as const,
      url:         m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
    })),
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
    },
    arbCandidates: finalArb,
  };

  return NextResponse.json(body);
}
