import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';
import { buildTraderAnalytics, WalletRecord } from '@/lib/trader-analytics';

export const dynamic = 'force-dynamic';

// Serves ONE trader's live fill/position feed from agent30 (/tmp/trader-feed.json),
// with honest P&L reconstruction (lib/trader-analytics) and free-tier redaction.
// The `updatedAt` / `feedHealthy` here are the AGENT's real values — the page's
// "as of HH:MM:SS" + feed-health indicator reflect the true feed state, never
// fresher than the file.
const FEED_FILE = '/tmp/trader-feed.json';
const STALE_MS  = 3 * 60_000; // 3 min — WS keeps this fresh; longer ⇒ show a "stale" hint

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

  const analytics = buildTraderAnalytics(rec);

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
