import { NextResponse } from 'next/server';
import fs from 'fs';

const EXCHANGE_FILE  = '/tmp/exchange-prices.json';
const BINANCE_FILE   = '/tmp/binance-prices.json';  // fallback if agent hasn't run yet
const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const KALSHI_API     = 'https://api.elections.kalshi.com/trade-api/v2';

const CRYPTO_KEYWORDS = ['btc','bitcoin','eth','ethereum','sol','solana','bnb','xrp','ripple','doge','dogecoin','crypto'];

// ── Types ─────────────────────────────────────────

export interface ExchangePrice {
  price:        number;
  change24hPct?: number;
  high24h?:     number;
  low24h?:      number;
  volume?:      number;
}

export interface CexArbOpp {
  coin:      string;
  low:       string;   // exchange name
  lowPrice:  number;
  high:      string;   // exchange name
  highPrice: number;
  spreadPct: number;
}

export interface CryptoMarket {
  id:          string;
  platform:    'polymarket' | 'kalshi';
  question:    string;
  probability: number;
  coin:        string | null;  // 'BTC' | 'ETH' | etc.
  url:         string;
  volume:      number | null;
  expiresAt:   number | null;
  infoLag:     boolean;
}

export interface CryptoResponse {
  exchanges:     Record<string, Record<string, ExchangePrice>>; // exchange → coin → price
  cexArb:        CexArbOpp[];
  infoLag:       Record<string, boolean>;                       // coin → bool
  cryptoMarkets: CryptoMarket[];
  fetchedAt:     number;
  dataAge:       number;   // ms since last agent run
}

// ── Helpers ───────────────────────────────────────

function toMs(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v < 9_999_999_999 ? v * 1000 : v;
  if (typeof v === 'string') { const d = Date.parse(v); return isNaN(d) ? null : d; }
  return null;
}

function loadExchangeData(): { fetchedAt: number; exchanges: Record<string, Record<string, ExchangePrice>>; cexArb: CexArbOpp[]; infoLag: Record<string, boolean> } | null {
  // Try new multi-exchange file first
  try {
    const raw  = fs.readFileSync(EXCHANGE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.exchanges) return data;
  } catch {}
  // Fall back to single-exchange Binance file
  try {
    const raw  = fs.readFileSync(BINANCE_FILE, 'utf8');
    const data = JSON.parse(raw);
    const binance: Record<string, ExchangePrice> = {};
    const infoLag: Record<string, boolean> = {};
    for (const [sym, v] of Object.entries(data.prices ?? {})) {
      const coin = sym.replace('USDT','');
      binance[coin] = { price: (v as any).price, change24hPct: (v as any).priceChangePercent24h };
      infoLag[coin] = (v as any).infoLag ?? false;
    }
    return { fetchedAt: data.fetchedAt, exchanges: { binance }, cexArb: [], infoLag };
  } catch {}
  return null;
}

function matchCoin(text: string): string | null {
  const t = text.toLowerCase();
  if (t.includes('bitcoin') || /\bbtc\b/.test(t))  return 'BTC';
  if (t.includes('ethereum') || /\beth\b/.test(t)) return 'ETH';
  if (t.includes('solana')  || /\bsol\b/.test(t))  return 'SOL';
  if (/\bbnb\b/.test(t))                            return 'BNB';
  if (t.includes('xrp') || t.includes('ripple'))   return 'XRP';
  if (t.includes('doge') || t.includes('dogecoin'))return 'DOGE';
  return null;
}

function isCrypto(text: string): boolean {
  const t = text.toLowerCase();
  return CRYPTO_KEYWORDS.some(kw => t.includes(kw));
}

function polymarketPrice(m: any): number | null {
  try {
    const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    if (Array.isArray(prices) && prices[0]) { const p = parseFloat(prices[0]); if (p > 0) return Math.round(p * 100); }
  } catch {}
  const ltp = parseFloat(m.lastTradePrice || '0');
  return ltp > 0 ? Math.round(ltp * 100) : null;
}

function kalshiPrice(m: any): number {
  const bid = parseFloat(m.yes_bid_dollars || '0');
  const ask = parseFloat(m.yes_ask_dollars || '0');
  if (bid > 0 && ask > 0) return Math.round(((bid + ask) / 2) * 100);
  return Math.round((ask || bid) * 100);
}

// ── Route ─────────────────────────────────────────

export async function GET() {
  const agentData = loadExchangeData();
  const exchanges = agentData?.exchanges ?? {};
  const cexArb    = agentData?.cexArb    ?? [];
  const infoLag   = agentData?.infoLag   ?? {};
  const dataAge   = agentData ? Date.now() - agentData.fetchedAt : Infinity;

  // Fetch crypto prediction markets from Polymarket and Kalshi
  const [pmRaw, kaRaw] = await Promise.all([
    fetch(`${POLYMARKET_API}/markets?active=true&limit=200`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => []),
    fetch(`${KALSHI_API}/markets?limit=200&status=open`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ markets: [] })),
  ]);

  const cryptoMarkets: CryptoMarket[] = [];

  // Polymarket
  for (const m of (Array.isArray(pmRaw) ? pmRaw : [])) {
    const q = String(m.question ?? m.title ?? '');
    if (!isCrypto(q)) continue;
    const prob = polymarketPrice(m);
    if (prob == null || prob < 1 || prob > 99) continue;
    const coin = matchCoin(q);
    cryptoMarkets.push({
      id: `pm-${m.id}`, platform: 'polymarket', question: q, probability: prob,
      coin,
      url:      m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
      volume:   m.volume != null ? parseFloat(m.volume) : null,
      expiresAt: toMs(m.endDateIso ?? m.end_date_iso ?? m.endDate),
      infoLag:  !!(coin && infoLag[coin] && dataAge < 600_000),
    });
  }

  // Kalshi
  for (const m of ((kaRaw.markets ?? []) as any[])) {
    const q = String(m.title ?? '');
    if (!isCrypto(q)) continue;
    const prob = kalshiPrice(m);
    if (prob < 1 || prob > 99) continue;
    const coin = matchCoin(q);
    cryptoMarkets.push({
      id: `ka-${m.ticker}`, platform: 'kalshi', question: q, probability: prob,
      coin,
      url:      `https://kalshi.com/markets/${m.ticker}`,
      volume:   m.volume ?? null,
      expiresAt: toMs(m.expiration_time ?? m.close_time),
      infoLag:  !!(coin && infoLag[coin] && dataAge < 600_000),
    });
  }

  cryptoMarkets.sort((a, b) => {
    if (a.infoLag !== b.infoLag) return a.infoLag ? -1 : 1;
    return (b.volume ?? 0) - (a.volume ?? 0);
  });

  return NextResponse.json({
    exchanges, cexArb, infoLag, cryptoMarkets,
    fetchedAt: Date.now(), dataAge,
  } satisfies CryptoResponse);
}
