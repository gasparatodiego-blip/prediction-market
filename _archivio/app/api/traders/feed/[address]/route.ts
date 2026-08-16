import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';
import { buildTraderAnalytics, WalletRecord } from '@/lib/trader-analytics';
// @ts-ignore — CommonJS helper (allowJs); shared with agent30 so feed & on-demand
// refresh classify/normalise open positions identically (no feed-vs-ondemand drift).
import { fetchOpenPositions, normPosition } from '@/lib/open-positions-fetch';

export const dynamic = 'force-dynamic';

// Serves ONE trader's live fill/position feed from agent30 (/tmp/trader-feed.json),
// with honest P&L reconstruction (lib/trader-analytics) and free-tier redaction.
// The `updatedAt` / `feedHealthy` here are the AGENT's real values — the page's
// "as of HH:MM:SS" + feed-health indicator reflect the true feed state, never
// fresher than the file.
const FEED_FILE = '/tmp/trader-feed.json';
const STALE_MS  = 3 * 60_000; // 3 min — WS keeps this fresh; longer ⇒ show a "stale" hint

// On-demand OPEN-position refresh for the viewed wallet ─────────────────────────
// agent30 resyncs positions only every ~10 min, but crypto Up/Down markets are 5-min
// —so a snapshot lags the live source by up to two market generations and the OPEN
// count reads stale. When a wallet's detail page is viewed we refetch ITS open set
// from the source (Polymarket's own redeemable=false filter, same shared helper) so
// displayed open == source open at view time. HONEST: only redeemable=false & |size|>0
// are open; the file's resolved/closed rows are kept verbatim so realized P&L never
// changes. Degrades to the stored snapshot on any error. A short TTL cache bounds
// source load against the page's 15s poll and concurrent viewers.
const OPEN_TTL_MS = 12_000;
const _openCache: Map<string, { at: number; open: any[]; observed: number; capped: boolean }> = new Map();

async function freshOpenPositions(address: string): Promise<{ open: any[]; observed: number; capped: boolean } | null> {
  const hit = _openCache.get(address);
  if (hit && Date.now() - hit.at < OPEN_TTL_MS) return { open: hit.open, observed: hit.observed, capped: hit.capped };
  const getJson = async (url: string) => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 9_000);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal, headers: { 'User-Agent': 'edgeradar/traderfeed' } });
      if (!r.ok) throw new Error(`data-api ${r.status}`);
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    } finally { clearTimeout(to); }
  };
  try {
    const { ok, open, openObserved, openScanCapped } = await fetchOpenPositions(getJson, address, { maxKeep: 60 });
    if (!ok) return null;                          // couldn't fetch → caller keeps stored snapshot
    const norm = (open as any[]).map(normPosition).filter(Boolean);
    const res = { open: norm, observed: openObserved as number, capped: !!openScanCapped || (openObserved as number) > norm.length };
    _openCache.set(address, { at: Date.now(), ...res });
    return res;
  } catch { return null; }
}

export async function GET(_req: NextRequest, { params }: { params: { address: string } }) {
  const address = (params.address || '').toLowerCase();

  let file: any;
  try { file = JSON.parse(fs.readFileSync(FEED_FILE, 'utf8')); }
  catch {
    return NextResponse.json(
      { ok: false, address, error: 'Trader feed warming up — agent30 has not written yet.', feedHealthy: false },
      { status: 503 },
    );
  }

  const rec: WalletRecord | undefined = file.wallets?.[address];
  const fileAge = Date.now() - new Date(file.updatedAt ?? 0).getTime();

  if (!rec) {
    // Wallet not yet in the feed (tracked set = qualifying leaderboard wallets;
    // a brand-new open may not have resynced). Honest 404 — never fabricate.
    return NextResponse.json(
      {
        ok: false, address, error: 'No feed for this wallet yet — it may not be in the tracked leaderboard set, or the next resync will pick it up.',
        updatedAt: file.updatedAt, feedHealthy: !!file.feedHealthy, resyncing: !!file.resyncing,
      },
      { status: 404 },
    );
  }

  // On-demand refresh of THIS wallet's open set so the displayed open count matches
  // the source at view time (agent30's 10-min snapshot lags 5-min markets). Keeps the
  // file's resolved/closed rows → realized numbers unchanged. Degrades to stored.
  let recForBuild: WalletRecord = rec;
  let openAsOf: string | null = null;
  const fresh = await freshOpenPositions(address);
  if (fresh) {
    const stored = Array.isArray(rec.positions) ? (rec.positions as any[]) : [];
    const openAssets = new Set(fresh.open.map((p: any) => String(p.asset)));
    // Drop the file's now-stale OPEN rows (redeemable=false & |size|>0) and any row
    // the fresh set already covers; keep resolved/closed/settled verbatim (realized).
    const nonOpenFromFile = stored.filter((p: any) =>
      !(p.redeemable === false && Math.abs(Number(p.size) || 0) > 0) && !openAssets.has(String(p.asset)));
    recForBuild = {
      ...rec,
      positions: [...fresh.open, ...nonOpenFromFile],
      openObserved: fresh.observed,
      openCapped: fresh.capped,
    } as WalletRecord;
    openAsOf = new Date().toISOString();
  }

  const analytics = buildTraderAnalytics(recForBuild);

  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);

  const body = redactForTier(
    {
      ok: true,
      address,
      isPaid,
      updatedAt:        file.updatedAt,          // TRUE last feed write (drives "as of")
      feedHealthy:      !!file.feedHealthy,
      wsConnected:      !!file.wsConnected,
      resyncing:        !!file.resyncing,
      lastWsMsgAt:      file.lastWsMsgAt ?? null,
      lastFullResyncAt: file.lastFullResyncAt ?? null,
      stale:            fileAge > STALE_MS,
      openAsOf,                                   // when the OPEN set was refreshed from source (null ⇒ using snapshot)
      since:            rec.firstFillTs ?? null,
      lastTradeTs:      rec.lastFillTs ?? null,
      fillsCount:       rec.fillsCount ?? (rec.fills?.length ?? 0),
      fillsCapped:      !!rec.fillsCapped,
      fillsPerWallet:   file.fillsPerWallet ?? null,
      summary:          analytics.summary,
      positions:        analytics.positions,
      equityCurve:      analytics.equityCurve,
      categoryPnl:      analytics.categoryPnl,
      fills:            rec.fills ?? [],          // raw fills for the fill table + price-marked chart
      feedSource:       file.source ?? null,
    },
    'trader-feed',
    isPaid,
  );

  return NextResponse.json(body);
}
