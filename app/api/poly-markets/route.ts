import { NextResponse } from 'next/server';
import fs from 'fs';
// @ts-ignore — lib/category.js is a shared CommonJS module (allowJs); the honest
// native-tag → canonical-category taxonomy used across agent20/agent21 and here.
import { inferCategory, CATEGORY_ORDER } from '@/lib/category';
import { polymarketMarketUrl } from '@/lib/platform-links';

export const dynamic = 'force-dynamic';

// Reads the collector's raw Polymarket dump and groups ACTIVE markets by
// Polymarket's OWN native categories (from event.tags[], persisted per market by
// agent-data-collector). Honest-engine: these are market-implied probabilities
// (CLOB bid/ask mid) — NOT our forecast, NOT an edge/ROI. Missing → null (UI: "—").
const RAW_FILE = '/tmp/polymarket-raw.json';
const STALE_MS = 15 * 60_000; // collector cycles every 3 min
const TOP_N = 30;             // rows returned per category (chip count is the full total)

type Row = {
  question: string | null;
  slug: string | null;
  impliedProb: number | null;   // YES probability 0..1 (CLOB mid or last), never fabricated
  volume24hr: number | null;
  volumeTotal: number | null;
  endDate: string | null;
  polyUrl: string | null;
};

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// Market-implied YES probability. Prefer the two-sided CLOB mid when the book is
// real (both sides present, sane, plausible spread); else the last trade; else
// missing. Never invent a value from an empty/defaulted book.
function impliedYes(m: any): number | null {
  const bid = num(m.bestBid), ask = num(m.bestAsk), ltp = num(m.lastTradePrice);
  const sane = (v: number | null): v is number => v != null && v >= 0 && v <= 1;
  if (sane(bid) && sane(ask) && ask >= bid && ask - bid <= 0.9) {
    const mid = (bid + ask) / 2;
    if (mid > 0 && mid < 1) return mid;
  }
  if (sane(ltp) && ltp > 0 && ltp < 1) return ltp;
  return null;
}

function build() {
  const stat = fs.statSync(RAW_FILE);
  if (_cache && _cache.mtimeMs === stat.mtimeMs) return _cache.payload;

  const raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  const markets: any[] = Array.isArray(raw.markets) ? raw.markets : [];

  const groups = new Map<string, Array<Row & { _v24: number; _vtot: number }>>();
  let totalActive = 0;
  for (const m of markets) {
    if (!m.active || m.closed || m.archived) continue;
    totalActive++;
    const tags = Array.isArray(m.tags) ? m.tags : [];
    const cat = inferCategory(tags) as string;
    const vol24 = num(m.volume24hr);
    const volTot = num(m.volumeNum);
    // Parent EVENT slug is the real Polymarket page; a per-outcome market slug 404s
    // on /event/. Prefer the collector-harvested eventSlug, then any nested event slug.
    const eventSlug = m.eventSlug || (m.events && m.events[0] && m.events[0].slug) || null;
    const row = {
      question: m.question || m.title || null,
      slug: m.slug || null,
      impliedProb: impliedYes(m),
      volume24hr: vol24,
      volumeTotal: volTot,
      endDate: m.endDate || null,
      polyUrl: polymarketMarketUrl(eventSlug || m.slug),
      _v24: vol24 != null && vol24 > 0 ? vol24 : 0,
      _vtot: volTot != null && volTot > 0 ? volTot : 0,
    };
    let bucket = groups.get(cat);
    if (!bucket) { bucket = []; groups.set(cat, bucket); }
    bucket.push(row);
  }

  // Canonical order (shared taxonomy), 'other' residual last. Hide empty categories.
  const order = [...CATEGORY_ORDER, 'other'];
  const categories = [];
  for (const label of order) {
    const bucket = groups.get(label);
    if (!bucket || !bucket.length) continue; // hide-empty honesty (same as leaderboard chips)
    // Sort by volume24hr (liveness): markets actually traded in the last 24h rank
    // first; those with no recent volume fall below, ordered by lifetime volume — so
    // a stale-but-active market never sits atop today's live ones. No fabrication.
    bucket.sort((a, b) => {
      if ((a._v24 > 0) !== (b._v24 > 0)) return a._v24 > 0 ? -1 : 1;
      if (a._v24 !== b._v24) return b._v24 - a._v24;
      return b._vtot - a._vtot;
    });
    categories.push({
      key: label,
      label,
      count: bucket.length,
      markets: bucket.slice(0, TOP_N).map(({ _v24, _vtot, ...r }) => r),
    });
  }

  const age = Date.now() - Number(raw.fetchedAt ?? 0);
  const payload = {
    ok: true,
    platform: 'Polymarket',
    kind: 'clob-market-implied', // CLOB (cashable venue) read as market-implied probability — indicative, not our forecast
    updatedAt: raw.fetchedAt ?? null,
    stale: age > STALE_MS,
    totalActive,
    categories,
  };

  _cache = { mtimeMs: stat.mtimeMs, payload };
  return payload;
}

// mtime-keyed module cache — the raw dump is ~160MB; parse+group once per collector
// write instead of on every request.
let _cache: { mtimeMs: number; payload: any } | null = null;

export async function GET() {
  try {
    return NextResponse.json(build());
  } catch (e: any) {
    // Calm empty state — never an error wall (honest-engine: zero is a valid state).
    return NextResponse.json({
      ok: false,
      platform: 'Polymarket',
      kind: 'clob-market-implied',
      categories: [],
      totalActive: 0,
      error: e?.message || 'poly-markets unavailable',
    });
  }
}
