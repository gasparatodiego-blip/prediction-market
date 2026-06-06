import { NextResponse } from 'next/server';
import fs from 'fs';
import { loadBucketsSync, computeBiasScore, type CalibrationBucket } from '@/lib/calibration';

// ── Types ─────────────────────────────────────────

export interface PanelMarket {
  id: string;
  name: string;
  detail: string;
  probability: number | null;
  volume?: number | null;
  expiresAt?: number | null;
}

export interface ArbCandidate {
  id: string;
  question: string;
  probability: number;
  platform: 'predictit' | 'manifold' | 'kalshi' | 'polymarket' | 'betfair' | 'metaculus' | 'augur' | 'gnosis' | 'futuur' | 'goodjudgment' | 'oddsapi' | 'opinionmarkets';
  bookmaker?: string;
  url?: string;
  volume?: number | null;
  liquidity?: number | null;
  expiresAt?: number | null;
  priceSeenAt?: number | null;
  biasScore?: number | null;
}

export interface MarketsResponse {
  panels: {
    predictit:      PanelMarket[];
    manifold:       PanelMarket[];
    kalshi:         PanelMarket[];
    polymarket:     PanelMarket[];
    betfair:        PanelMarket[];
    metaculus:      PanelMarket[];
    augur:          PanelMarket[];
    gnosis:         PanelMarket[];
    futuur:         PanelMarket[];
    goodjudgment:   PanelMarket[];
    oddsapi:        PanelMarket[];
    opinionmarkets: PanelMarket[];
  };
  arbCandidates: ArbCandidate[];
}

// ── Helpers ───────────────────────────────────────

function toMs(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v < 9_999_999_999 ? v * 1000 : v;
  if (typeof v === 'string') { const d = Date.parse(v); return isNaN(d) ? null : d; }
  return null;
}

function readJson(path: string): any {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

// ── Normalise price helpers ───────────────────────

function kalshiPrice(m: any): number | null {
  const bid = parseFloat(m.yes_bid_dollars || '0');
  const ask = parseFloat(m.yes_ask_dollars || '0');
  const last = parseFloat(m.last_price_dollars || '0');
  let p = 0;
  if (bid > 0 && ask > 0) p = (bid + ask) / 2;
  else if (ask > 0) p = ask;
  else if (bid > 0) p = bid;
  else if (last > 0) p = last;
  const pct = Math.round(p * 100);
  return pct > 0 && pct < 100 ? pct : null;
}

function polymarketPrice(m: any): number | null {
  try {
    const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    if (Array.isArray(prices) && prices[0]) {
      const p = parseFloat(prices[0]);
      if (p > 0) return Math.round(p * 100);
    }
  } catch {}
  const ltp = parseFloat(m.lastTradePrice || '0');
  return ltp > 0 ? Math.round(ltp * 100) : null;
}

// ── Load /tmp files ────────────────────────────────

const MARKETS_RAW_FILE    = '/tmp/markets-raw.json';
const KALSHI_RAW_FILE     = '/tmp/kalshi-raw.json';
const POLYMARKET_RAW_FILE = '/tmp/polymarket-raw.json';
const MANIFOLD_RAW_FILE   = '/tmp/manifold-raw.json';
const PREDICTIT_RAW_FILE  = '/tmp/predictit-raw.json';
const METACULUS_RAW_FILE  = '/tmp/metaculus-raw.json';
const ODDS_API_FILE       = '/tmp/odds-api-raw.json';
const BETFAIR_RAW_FILE    = '/tmp/betfair-raw.json';
const AUGUR_RAW_FILE      = '/tmp/augur-raw.json';
const GNOSIS_RAW_FILE     = '/tmp/gnosis-raw.json';
const FUTUUR_RAW_FILE     = '/tmp/futuur-raw.json';
const GOODJUDGMENT_FILE   = '/tmp/goodjudgment-raw.json';
const ARB_FILE            = '/tmp/arbitrage-opportunities.json';
const UI_DATA_FILE        = '/tmp/ui-data.json';
const PRICES_FILE         = '/tmp/arb-prices.json';

function loadMarketsRaw() { return readJson(MARKETS_RAW_FILE); }

function loadKalshiMarkets(): any[] {
  const d = readJson(KALSHI_RAW_FILE);
  if (d?.markets?.length) return d.markets;
  return readJson(MARKETS_RAW_FILE)?.kalshi ?? [];
}

function loadPolymarketMarkets(): any[] {
  const d = readJson(POLYMARKET_RAW_FILE);
  if (d?.markets?.length) return d.markets;
  return readJson(MARKETS_RAW_FILE)?.polymarket ?? [];
}

function loadManifoldMarkets(): any[] {
  const d = readJson(MANIFOLD_RAW_FILE);
  if (d?.markets?.length) return d.markets;
  return readJson(MARKETS_RAW_FILE)?.manifold ?? [];
}

function loadPredictItMarkets(): any[] {
  const d = readJson(PREDICTIT_RAW_FILE);
  if (d?.markets?.length) return d.markets;
  return readJson(MARKETS_RAW_FILE)?.predictit ?? [];
}

function loadMetaculusQuestions(): any[] {
  const d = readJson(METACULUS_RAW_FILE);
  return d?.questions ?? [];
}

function loadOddsApiEvents(): any[] {
  const data = readJson(ODDS_API_FILE);
  return data?.events ?? [];
}

function loadBetfairMarkets(): any[] {
  const d = readJson(BETFAIR_RAW_FILE);
  return d?.markets ?? [];
}

function loadAugurMarkets(): any[] {
  const d = readJson(AUGUR_RAW_FILE);
  return d?.markets ?? [];
}

function loadGnosisMarkets(): any[] {
  const d = readJson(GNOSIS_RAW_FILE);
  return d?.markets ?? [];
}

function loadFutuurMarkets(): any[] {
  const d = readJson(FUTUUR_RAW_FILE);
  return d?.markets ?? [];
}

function loadGoodJudgmentQuestions(): any[] {
  const d = readJson(GOODJUDGMENT_FILE);
  return d?.questions ?? [];
}

// ── Odds API panels ────────────────────────────────

interface BookmakerOdds { bm: string; bmTitle: string; prob: number; }

function oddsApiEventCandidates(events: any[]): ArbCandidate[] {
  const candidates: ArbCandidate[] = [];
  for (const ev of events) {
    const outcomeMap: Record<string, BookmakerOdds[]> = {};
    for (const bm of ev.bookmakers ?? []) {
      const h2h = (bm.markets ?? []).find((m: any) => m.key === 'h2h');
      if (!h2h) continue;
      for (const outcome of h2h.outcomes ?? []) {
        if (!outcome.price || outcome.price <= 1) continue;
        const prob = (1 / outcome.price) * 100;
        if (!outcomeMap[outcome.name]) outcomeMap[outcome.name] = [];
        outcomeMap[outcome.name].push({ bm: bm.key, bmTitle: bm.title || bm.key, prob });
      }
    }
    for (const [outcomeName, entries] of Object.entries(outcomeMap)) {
      if (entries.length < 2) continue;
      const spread = Math.max(...entries.map(e => e.prob)) - Math.min(...entries.map(e => e.prob));
      if (spread < 2) continue;
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
  return events
    .map(ev => {
      const homeProbs: number[] = [];
      for (const bm of ev.bookmakers ?? []) {
        const h2h = (bm.markets ?? []).find((m: any) => m.key === 'h2h');
        const outcome = (h2h?.outcomes ?? []).find((o: any) => o.name === ev.home_team);
        if (outcome?.price > 1) homeProbs.push((1 / outcome.price) * 100);
      }
      if (!homeProbs.length) return null;
      const spread = Math.max(...homeProbs) - Math.min(...homeProbs);
      return {
        id:          ev.id,
        name:        `${ev.home_team} vs ${ev.away_team}`,
        detail:      `${ev.sport_title} · ${homeProbs.length} bookmakers · spread ${spread.toFixed(1)}%`,
        probability: Math.round((homeProbs.reduce((a, b) => a + b, 0) / homeProbs.length) * 10) / 10,
        volume:      null,
        expiresAt:   toMs(ev.commence_time),
      } as PanelMarket;
    })
    .filter(Boolean)
    .sort((a: any, b: any) => {
      const sa = parseFloat(a.detail.split('spread ')[1] ?? '0');
      const sb = parseFloat(b.detail.split('spread ')[1] ?? '0');
      return sb - sa;
    })
    .slice(0, 30) as PanelMarket[];
}

function buildAugurPanel(markets: any[]): PanelMarket[] {
  return markets
    .filter(m => m.outcomes?.length >= 2)
    .map(m => {
      const yes = m.outcomes.find((o: any) => o.description?.toLowerCase().includes('yes'));
      const price = yes ? +(parseFloat(yes.price || '0') * 100).toFixed(1) : null;
      if (price == null) return null;
      return {
        id:          m.id,
        name:        m.description?.slice(0, 80) ?? 'Unknown',
        detail:      `Augur · vol: ${parseFloat(m.volume || '0').toFixed(0)} DAI`,
        probability: price,
        volume:      parseFloat(m.volume || '0'),
        expiresAt:   m.endTime ? parseInt(m.endTime) * 1000 : null,
      } as PanelMarket;
    })
    .filter(Boolean)
    .slice(0, 30) as PanelMarket[];
}

function buildGnosisPanel(markets: any[]): PanelMarket[] {
  return markets
    .filter(m => m.title && m.prices?.length)
    .map(m => {
      const yes = m.prices.find((p: any) => p.outcome?.toLowerCase().includes('yes') || p.outcome?.toLowerCase().includes('true'));
      const price = yes ? +(yes.price * 100).toFixed(1) : +(m.prices[0]?.price * 100 || 0).toFixed(1);
      if (!price || price < 1 || price > 99) return null;
      return {
        id:          m.id,
        name:        m.title?.slice(0, 80) ?? 'Unknown',
        detail:      `Gnosis/Omen · vol: ${m.volume?.toFixed(0) ?? 0} DAI`,
        probability: price,
        volume:      m.volume ?? null,
        expiresAt:   m.resolvesAt ? new Date(m.resolvesAt).getTime() : null,
      } as PanelMarket;
    })
    .filter(Boolean)
    .slice(0, 30) as PanelMarket[];
}

function buildFutuurPanel(markets: any[]): PanelMarket[] {
  return markets
    .filter(m => m.title && m.outcomes?.length)
    .map(m => {
      const yes = m.outcomes.find((o: any) => o.label?.toLowerCase().includes('yes') || o.label?.toLowerCase().includes('true'));
      const prob = yes?.prob ?? m.outcomes[0]?.prob;
      if (prob == null) return null;
      const price = +(prob * 100).toFixed(1);
      if (price < 1 || price > 99) return null;
      return {
        id:          String(m.id ?? m.title),
        name:        m.title?.slice(0, 80) ?? 'Unknown',
        detail:      `Futuur · ${m.category ?? 'General'}`,
        probability: price,
        volume:      m.volume ?? null,
        expiresAt:   m.endsAt ? new Date(m.endsAt).getTime() : null,
      } as PanelMarket;
    })
    .filter(Boolean)
    .slice(0, 30) as PanelMarket[];
}

function buildGoodJudgmentPanel(questions: any[]): PanelMarket[] {
  return questions
    .filter(q => q.title && q.probability != null)
    .map(q => {
      const price = +(q.probability * 100).toFixed(1);
      if (price < 1 || price > 99) return null;
      return {
        id:          String(q.id),
        name:        q.title?.slice(0, 80) ?? 'Unknown',
        detail:      `Good Judgment Open · ${q.forecasters ?? 0} forecasters`,
        probability: price,
        volume:      null,
        expiresAt:   q.closesAt ? new Date(q.closesAt).getTime() : null,
      } as PanelMarket;
    })
    .filter(Boolean)
    .slice(0, 30) as PanelMarket[];
}

function buildBetfairRawPanel(markets: any[]): PanelMarket[] {
  return markets
    .filter(m => m.outcomes?.length)
    .map(m => {
      const outcome = m.outcomes[0];
      return {
        id:          String(m.id ?? Math.random()),
        name:        m.event?.slice(0, 80) ?? 'Unknown',
        detail:      `Betfair · ${m.sport ?? m.bookmaker ?? ''} · ${outcome.price?.toFixed(2) ?? '?'}`,
        probability: outcome.price > 1 ? +(100 / outcome.price).toFixed(1) : 50,
        volume:      null,
        expiresAt:   m.commenceTime ? new Date(m.commenceTime).getTime() : null,
      } as PanelMarket;
    })
    .filter(Boolean)
    .slice(0, 30) as PanelMarket[];
}

function buildBetfairPanel(events: any[]): PanelMarket[] {
  const panels: PanelMarket[] = [];
  for (const ev of events) {
    const bfBm = (ev.bookmakers ?? []).find((b: any) => b.key === 'betfair_ex_eu');
    if (!bfBm) continue;
    const h2h = (bfBm.markets ?? []).find((m: any) => m.key === 'h2h');
    if (!h2h) continue;
    for (const outcome of h2h.outcomes ?? []) {
      if (!outcome.price || outcome.price <= 1) continue;
      panels.push({
        id:          `bf-${ev.id}-${outcome.name.replace(/\s+/g, '_')}`,
        name:        `${ev.home_team} vs ${ev.away_team} — ${outcome.name}`,
        detail:      `${ev.sport_title} · Betfair Exchange · ${outcome.price.toFixed(2)} dec`,
        probability: Math.round((1 / outcome.price) * 1000) / 10,
        volume:      null,
        expiresAt:   toMs(ev.commence_time),
      });
    }
  }
  return panels.slice(0, 30);
}

// ── Agent arb cache ────────────────────────────────

function loadAgentArb(): ArbCandidate[] | null {
  for (const f of [UI_DATA_FILE, ARB_FILE]) {
    try {
      const data = readJson(f);
      if (!data) continue;
      const age = Date.now() - (data.refreshedAt ?? data.updatedAt ?? 0);
      if (age > 3_600_000) continue; // up to 60 min stale

      const opps: any[] = data.opportunities ?? [];
      if (!opps.length) continue;

      // New master-agent format
      if (opps[0]?.source === 'AI Master') {
        return opps.map((o: any) => ({
          id:          o.id,
          question:    o.title,
          probability: Math.min(99, Math.max(1, Math.round(o.confidence ?? 50))),
          platform:    'manifold' as const,
          url:         undefined,
          volume:      null,
          liquidity:   null,
          expiresAt:   null,
          _master:     o,
        }));
      }

      // Legacy pipeline format
      if (opps[0]?.lowMarket) {
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
      }
    } catch {}
  }
  return null;
}

// ── Price staleness tracking ──────────────────────

type PriceRecord = { p: number; t: number };

function loadPriceSeen(): Record<string, PriceRecord> {
  try { return JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8')); } catch { return {}; }
}

function stampCandidates(candidates: ArbCandidate[]): ArbCandidate[] {
  const seen   = loadPriceSeen();
  const now    = Date.now();
  const update = { ...seen };

  const stamped = candidates.map(c => {
    const key    = `${c.platform}:${c.id}`;
    const prev   = seen[key];
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

// ── Route ─────────────────────────────────────────

export async function GET() {
  const marketsRaw = loadMarketsRaw();
  const oddsEvents = loadOddsApiEvents();

  // ── Normalise prediction market data ─────────────

  // PredictIt: dedicated file takes priority
  const piAllMarkets: any[] = (() => {
    const d = loadPredictItMarkets();
    return d.length ? d : (marketsRaw?.predictit ?? []);
  })();
  const piMarkets = piAllMarkets.slice(0, 20);

  // Manifold: dedicated file takes priority
  const mfMarkets: any[] = (() => {
    const d = loadManifoldMarkets();
    const src = d.length ? d : (marketsRaw?.manifold ?? []);
    return (src as any[]).filter((m: any) => m.outcomeType === 'BINARY' && m.probability != null && !m.isResolved).slice(0, 20);
  })();

  // Metaculus
  const mcQuestions: any[] = loadMetaculusQuestions().slice(0, 20);

  // Kalshi: dedicated agent file takes priority
  const kaAllMarkets: any[] = loadKalshiMarkets();
  const kaMarkets = kaAllMarkets
    .filter((m: any) => kalshiPrice(m) !== null)
    .slice(0, 60);

  // Polymarket: dedicated agent file takes priority
  const pmAllMarkets: any[] = loadPolymarketMarkets();
  const pmMarkets = pmAllMarkets
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
    detail:      m.event_ticker?.includes('NBA') ? 'NBA' :
                 m.event_ticker?.includes('MLB') ? 'MLB' :
                 m.event_ticker?.includes('NFL') ? 'NFL' : 'Kalshi',
    probability: kalshiPrice(m),
    volume:      m.volume_fp != null ? parseFloat(m.volume_fp) : (m.volume ?? null),
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

  const metaculusPanel: PanelMarket[] = mcQuestions
    .filter((q: any) => q.probability != null)
    .map((q: any) => ({
      id:          String(q.id),
      name:        q.question,
      detail:      `Metaculus · ${q.numForecasts ?? 0} forecasters`,
      probability: Math.round((q.probability > 1 ? q.probability : q.probability * 100)),
      volume:      q.numForecasts ?? null,
      expiresAt:   toMs(q.closeTime),
    }));

  const oddsApiPanel    = buildOddsApiPanel(oddsEvents);
  const betfairPanel    = buildBetfairPanel(oddsEvents);
  const augurPanel      = buildAugurPanel(loadAugurMarkets());
  const gnosisPanel     = buildGnosisPanel(loadGnosisMarkets());
  const futuurPanel     = buildFutuurPanel(loadFutuurMarkets());
  const goodjudgPanel   = buildGoodJudgmentPanel(loadGoodJudgmentQuestions());
  const betfairRawPanel = buildBetfairRawPanel(loadBetfairMarkets().filter((m: any) => m.source !== 'odds-api'));

  // ── Arb candidates from prediction markets ────────

  const liveCandidates: ArbCandidate[] = [
    ...piAllMarkets.flatMap((m: any) =>
      (m.contracts ?? [])
        .filter((c: any) => c.lastTradePrice != null && c.lastTradePrice > 0)
        .map((c: any) => ({
          id:          `pi-${m.id}-${c.id}`,
          question:    c.name && c.name !== 'Yes' ? `${m.name} — ${c.name}` : String(m.name),
          probability: Math.round(c.lastTradePrice * 100),
          platform:    'predictit' as const,
          url:         `https://www.predictit.org/markets/detail/${m.id}`,
          volume:      m.tradedVolume ?? null,
          liquidity:   c.bestBuyYesCost != null ? Math.round(c.bestBuyYesCost * 850) : null,
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
      probability: kalshiPrice(m) ?? 50,
      platform:    'kalshi' as const,
      url:         `https://kalshi.com/markets/${m.ticker}`,
      volume:      m.volume_fp != null ? parseFloat(m.volume_fp) : (m.volume ?? null),
      liquidity:   null,
      expiresAt:   toMs(m.expiration_time ?? m.close_time),
    })),
    ...pmMarkets.map((m: any) => ({
      id:          `pm-${m.id}`,
      question:    String(m.question),
      probability: polymarketPrice(m) ?? 50,
      platform:    'polymarket' as const,
      url:         m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
      volume:      m.volume != null ? parseFloat(m.volume) : null,
      liquidity:   m.liquidity != null ? Math.round(parseFloat(m.liquidity)) : null,
      expiresAt:   toMs(m.endDateIso ?? m.end_date_iso ?? m.endDate),
    })),
    ...betfairPanel.map(m => ({
      id:          m.id,
      question:    m.name,
      probability: m.probability ?? 50,
      platform:    'betfair' as const,
      url:         'https://www.betfair.com/exchange',
      volume:      null,
      liquidity:   null,
      expiresAt:   m.expiresAt ?? null,
    })),
    ...oddsApiEventCandidates(oddsEvents),
    // Metaculus candidates
    ...mcQuestions
      .filter((q: any) => q.probability != null)
      .map((q: any) => ({
        id:          `mc-${q.id}`,
        question:    String(q.question),
        probability: Math.round(q.probability > 1 ? q.probability : q.probability * 100),
        platform:    'metaculus' as const,
        url:         q.url ?? null,
        volume:      q.numForecasts ?? null,
        liquidity:   null,
        expiresAt:   toMs(q.closeTime),
      })),
  ];

  // ── Calibration ───────────────────────────────────

  const calibBuckets: CalibrationBucket[] = loadBucketsSync();
  const scored = (candidates: ArbCandidate[]) =>
    candidates.map(c => ({ ...c, biasScore: computeBiasScore(c.probability, calibBuckets) }));

  const agentArb = loadAgentArb();
  const base     = agentArb ?? liveCandidates;
  const stamped  = stampCandidates(base);
  const finalArb = scored(stamped);

  // ── Master opportunities (rich format for Phase 3 dashboard) ──────────────
  const masterData = (() => {
    try { return JSON.parse(fs.readFileSync(ARB_FILE, 'utf8')); } catch { return null; }
  })();
  const masterOpps = (masterData?.opportunities ?? []).filter((o: any) => o.source === 'AI Master');

  const body: MarketsResponse & { masterOpportunities: any[] } = {
    panels: {
      predictit:      predictitPanel,
      manifold:       manifoldPanel,
      kalshi:         kalshiPanel,
      polymarket:     polymarketPanel,
      betfair:        [...betfairPanel, ...betfairRawPanel].slice(0, 30),
      metaculus:      metaculusPanel,
      augur:          augurPanel,
      gnosis:         gnosisPanel,
      futuur:         futuurPanel,
      goodjudgment:   goodjudgPanel,
      oddsapi:        oddsApiPanel,
      opinionmarkets: [],
    },
    arbCandidates:      finalArb,
    masterOpportunities: masterOpps,
  };

  return NextResponse.json(body);
}
