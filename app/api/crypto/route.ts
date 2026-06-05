import { NextResponse } from 'next/server';
import fs from 'fs';

const BINANCE_FILE   = '/tmp/binance-prices.json';
const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const KALSHI_API     = 'https://api.elections.kalshi.com/trade-api/v2';

const CRYPTO_KEYWORDS = ['btc','bitcoin','eth','ethereum','sol','solana','bnb','xrp','ripple','doge','dogecoin','crypto'];

export interface BinancePrice {
  symbol:               string;
  price:                number;
  priceChange24h:       number;
  priceChangePercent24h: number;
  high24h:              number;
  low24h:               number;
  volume:               number;
  change1hPct:          number;
  infoLag:              boolean;
}

export interface CryptoMarket {
  id:          string;
  platform:    'polymarket' | 'kalshi';
  question:    string;
  probability: number;
  symbol:      string | null;  // matched BTC/ETH/etc
  url:         string;
  volume:      number | null;
  expiresAt:   number | null;
  infoLag:     boolean;
}

export interface CryptoResponse {
  binance:       Record<string, BinancePrice>;
  cryptoMarkets: CryptoMarket[];
  fetchedAt:     number;
  binanceAge:    number;  // ms since last binance update
}

function toMs(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v < 9_999_999_999 ? v * 1000 : v;
  if (typeof v === 'string') { const d = Date.parse(v); return isNaN(d) ? null : d; }
  return null;
}

function loadBinance(): { prices: Record<string, BinancePrice>; fetchedAt: number } | null {
  try {
    const raw  = fs.readFileSync(BINANCE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data;
  } catch { return null; }
}

function matchSymbol(text: string): string | null {
  const t = text.toLowerCase();
  if (t.includes('bitcoin') || t.includes('btc'))     return 'BTCUSDT';
  if (t.includes('ethereum') || t.includes(' eth ') || t.includes('eth ') || /\beth\b/.test(t)) return 'ETHUSDT';
  if (t.includes('solana') || t.includes(' sol ') || /\bsol\b/.test(t))  return 'SOLUSDT';
  if (t.includes('bnb'))                               return 'BNBUSDT';
  if (t.includes('xrp') || t.includes('ripple'))      return 'XRPUSDT';
  if (t.includes('doge') || t.includes('dogecoin'))   return 'DOGEUSDT';
  return null;
}

function isCryptoMarket(text: string): boolean {
  const t = text.toLowerCase();
  return CRYPTO_KEYWORDS.some(kw => t.includes(kw));
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

function kalshiPrice(m: any): number {
  const bid = parseFloat(m.yes_bid_dollars || '0');
  const ask = parseFloat(m.yes_ask_dollars || '0');
  if (bid > 0 && ask > 0) return Math.round(((bid + ask) / 2) * 100);
  return Math.round((ask || bid) * 100);
}

export async function GET() {
  const binanceData = loadBinance();
  const binance     = binanceData?.prices ?? {};
  const binanceAge  = binanceData ? Date.now() - binanceData.fetchedAt : Infinity;

  // Fetch crypto markets from Polymarket and Kalshi in parallel
  const [pmRaw, kaRaw] = await Promise.all([
    fetch(`${POLYMARKET_API}/markets?active=true&limit=200`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => []),
    fetch(`${KALSHI_API}/markets?limit=200&status=open`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ markets: [] })),
  ]);

  const cryptoMarkets: CryptoMarket[] = [];

  // Polymarket crypto markets
  const pmList: any[] = Array.isArray(pmRaw) ? pmRaw : [];
  for (const m of pmList) {
    const q = String(m.question ?? m.title ?? '');
    if (!isCryptoMarket(q)) continue;
    const prob = polymarketPrice(m);
    if (prob == null || prob < 1 || prob > 99) continue;
    const sym    = matchSymbol(q);
    const bPrice = sym ? binance[sym] : null;
    const infoLag = !!(bPrice?.infoLag && binanceAge < 600_000);
    cryptoMarkets.push({
      id:          `pm-${m.id}`,
      platform:    'polymarket',
      question:    q,
      probability: prob,
      symbol:      sym,
      url:         m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
      volume:      m.volume != null ? parseFloat(m.volume) : null,
      expiresAt:   toMs(m.endDateIso ?? m.end_date_iso ?? m.endDate),
      infoLag,
    });
  }

  // Kalshi crypto markets
  const kaList: any[] = kaRaw.markets ?? [];
  for (const m of kaList) {
    const q = String(m.title ?? '');
    if (!isCryptoMarket(q)) continue;
    const prob = kalshiPrice(m);
    if (prob < 1 || prob > 99) continue;
    const sym    = matchSymbol(q);
    const bPrice = sym ? binance[sym] : null;
    const infoLag = !!(bPrice?.infoLag && binanceAge < 600_000);
    cryptoMarkets.push({
      id:          `ka-${m.ticker}`,
      platform:    'kalshi',
      question:    q,
      probability: prob,
      symbol:      sym,
      url:         `https://kalshi.com/markets/${m.ticker}`,
      volume:      m.volume ?? null,
      expiresAt:   toMs(m.expiration_time ?? m.close_time),
      infoLag,
    });
  }

  cryptoMarkets.sort((a, b) => {
    if (a.infoLag !== b.infoLag) return a.infoLag ? -1 : 1;
    return (b.volume ?? 0) - (a.volume ?? 0);
  });

  const body: CryptoResponse = {
    binance,
    cryptoMarkets,
    fetchedAt: Date.now(),
    binanceAge,
  };

  return NextResponse.json(body);
}
