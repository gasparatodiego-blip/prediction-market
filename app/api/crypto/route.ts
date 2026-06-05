import { NextResponse } from 'next/server';
import fs from 'fs';

const EXCHANGE_FILE = '/tmp/exchange-prices.json';
const DEX_FILE      = '/tmp/dex-prices.json';
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
  low:       string;
  lowPrice:  number;
  high:      string;
  highPrice: number;
  spreadPct: number;
}

export interface FuturesInfo {
  markPrice?:      number;
  fundingRate:     number;  // % per 8h (positive = longs pay shorts)
  nextFundingTime?: number; // Unix ms
}

export interface BasisTrade {
  coin:      string;
  spot:      number;
  futures:   number;
  basisPct:  number;  // (futures - spot) / spot * 100
  direction: 'contango' | 'backwardation';
  exchange:  string;
}

export interface HighFunding {
  coin:        string;
  exchange:    string;
  fundingRate: number;  // %
}

export interface DexPrice {
  price:        number;
  fundingRate?: number;
  openInterest?: number;
}

export interface DexCexSpread {
  coin:       string;
  dex:        string;
  dexPrice:   number;
  cex:        string;
  cexPrice:   number;
  spreadPct:  number;
}

export interface CryptoMarket {
  id:          string;
  platform:    'polymarket' | 'kalshi';
  question:    string;
  probability: number;
  coin:        string | null;
  url:         string;
  volume:      number | null;
  expiresAt:   number | null;
  infoLag:     boolean;
}

export interface CryptoResponse {
  exchanges:     Record<string, Record<string, ExchangePrice>>;
  cexArb:        CexArbOpp[];
  infoLag:       Record<string, boolean>;
  futures:       Record<string, Record<string, FuturesInfo>>;  // exchange → coin → data
  basisTrades:   BasisTrade[];
  highFunding:   HighFunding[];
  dex:           Record<string, Record<string, DexPrice>>;     // source → coin → price
  dexCexSpread:  DexCexSpread[];
  cryptoMarkets: CryptoMarket[];
  fetchedAt:     number;
  dataAge:       number;
}

// ── Data loaders ──────────────────────────────────

function loadExchangeData() {
  try {
    const d = JSON.parse(fs.readFileSync(EXCHANGE_FILE, 'utf8'));
    if (d.exchanges) return d;
  } catch {}
  return null;
}

function loadDexData(): { dex: Record<string, Record<string, DexPrice>>; dexCexSpread: DexCexSpread[] } {
  try {
    const d = JSON.parse(fs.readFileSync(DEX_FILE, 'utf8'));
    const age = Date.now() - (d.fetchedAt ?? 0);
    if (age < 900_000) return { dex: d.dex ?? {}, dexCexSpread: d.dexCexSpread ?? [] };
  } catch {}
  return { dex: {}, dexCexSpread: [] };
}

// ── Helpers ───────────────────────────────────────

function toMs(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v < 9_999_999_999 ? v * 1000 : v;
  if (typeof v === 'string') { const d = Date.parse(v); return isNaN(d) ? null : d; }
  return null;
}

function matchCoin(text: string): string | null {
  const t = text.toLowerCase();
  if (t.includes('bitcoin')  || /\bbtc\b/.test(t))  return 'BTC';
  if (t.includes('ethereum') || /\beth\b/.test(t))  return 'ETH';
  if (t.includes('solana')   || /\bsol\b/.test(t))  return 'SOL';
  if (/\bbnb\b/.test(t))                             return 'BNB';
  if (t.includes('xrp') || t.includes('ripple'))    return 'XRP';
  if (t.includes('doge') || t.includes('dogecoin')) return 'DOGE';
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
  const exData    = loadExchangeData();
  const exchanges = exData?.exchanges    ?? {};
  const cexArb    = exData?.cexArb       ?? [];
  const infoLag   = exData?.infoLag      ?? {};
  const futuresRaw: Record<string, Record<string, FuturesInfo>> = exData?.futures ?? {};
  const basisTrades: BasisTrade[] = exData?.basisTrades ?? [];
  const highFunding: HighFunding[] = exData?.highFunding ?? [];
  const dataAge   = exData ? Date.now() - exData.fetchedAt : Infinity;

  const { dex, dexCexSpread } = loadDexData();

  // Crypto prediction markets
  const [pmRaw, kaRaw] = await Promise.all([
    fetch(`${POLYMARKET_API}/markets?active=true&limit=200`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => []),
    fetch(`${KALSHI_API}/markets?limit=200&status=open`, { cache: 'no-store' })
      .then(r => r.json()).catch(() => ({ markets: [] })),
  ]);

  const cryptoMarkets: CryptoMarket[] = [];

  for (const m of (Array.isArray(pmRaw) ? pmRaw : [])) {
    const q = String(m.question ?? m.title ?? '');
    if (!isCrypto(q)) continue;
    const prob = polymarketPrice(m);
    if (prob == null || prob < 1 || prob > 99) continue;
    const coin = matchCoin(q);
    cryptoMarkets.push({
      id: `pm-${m.id}`, platform: 'polymarket', question: q, probability: prob, coin,
      url: m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
      volume: m.volume != null ? parseFloat(m.volume) : null,
      expiresAt: toMs(m.endDateIso ?? m.end_date_iso ?? m.endDate),
      infoLag: !!(coin && infoLag[coin] && dataAge < 600_000),
    });
  }

  for (const m of ((kaRaw.markets ?? []) as any[])) {
    const q = String(m.title ?? '');
    if (!isCrypto(q)) continue;
    const prob = kalshiPrice(m);
    if (prob < 1 || prob > 99) continue;
    const coin = matchCoin(q);
    cryptoMarkets.push({
      id: `ka-${m.ticker}`, platform: 'kalshi', question: q, probability: prob, coin,
      url: `https://kalshi.com/markets/${m.ticker}`,
      volume: m.volume ?? null,
      expiresAt: toMs(m.expiration_time ?? m.close_time),
      infoLag: !!(coin && infoLag[coin] && dataAge < 600_000),
    });
  }

  cryptoMarkets.sort((a, b) => {
    if (a.infoLag !== b.infoLag) return a.infoLag ? -1 : 1;
    return (b.volume ?? 0) - (a.volume ?? 0);
  });

  const body: CryptoResponse = {
    exchanges, cexArb, infoLag,
    futures: futuresRaw, basisTrades, highFunding,
    dex, dexCexSpread,
    cryptoMarkets,
    fetchedAt: Date.now(), dataAge,
  };

  return NextResponse.json(body);
}
