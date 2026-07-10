import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';
import { enrichClosedTradesEntryExit, attachClosedTradeFills, WalletRecord } from '@/lib/trader-analytics';
import { fetchWalletRecordOnDemand } from '@/lib/ondemand-fills';

export const dynamic = 'force-dynamic';

// Serves ONE trader's enriched profile (agent20 schema v2) on demand. The full
// `profiles` map in /tmp/leaderboard.json is multi-MB (172 traders × positions/
// trades/activity) — far too heavy to inline into the 60s-polled leaderboard
// list, so it's fetched per-wallet when a row is opened. hasProfile on the list
// entry tells the UI whether a profile exists before it fetches.
const LEADERBOARD_FILE = '/tmp/leaderboard.json';
const FEED_FILE = '/tmp/trader-feed.json';
const STALE_MS = 35 * 60_000; // 35 min (agent scans every 30 min)

export async function GET(_req: NextRequest, { params }: { params: { address: string } }) {
  const address = (params.address || '').toLowerCase();

  try {
    const raw  = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    const age  = Date.now() - new Date(raw.updatedAt ?? 0).getTime();
    const profile = raw.profiles?.[address] ?? null;

    if (!profile) {
      return NextResponse.json(
        { ok: false, address, profile: null, error: 'No profile for this wallet yet.' },
        { status: 404 },
      );
    }

    // Surface REAL entry→exit onto the aggregate closed-trades from agent30's
    // per-fill feed for this wallet (join by conditionId, reconcile against the
    // realized P&L agent20 already reports). agent20's ledger can't pin per-fill
    // prices → the column would otherwise show "— → —" despite the data existing.
    // Never touches realizedPnl; unreconcilable/absent rows stay "—" (honest).
    // Fast path: agent30 already tracks this wallet → use its live feed record.
    let rec: WalletRecord | undefined;
    try {
      const feed = JSON.parse(fs.readFileSync(FEED_FILE, 'utf8'));
      rec = feed.wallets?.[address];
      if (rec) {
        enrichClosedTradesEntryExit(profile.tradesClosed, rec);
        attachClosedTradeFills(profile.tradesClosed, rec);   // real per-fill drawer + time-to-expiry
        profile.entryExitSource = 'feed';
      }
    } catch { /* feed absent/warming → fall through to on-demand */ }

    // Non-feed wallet (the leaderboard ranks thousands, agent30 tracks ~hundreds):
    // reconstruct entry→exit on demand from the SAME keyless Data API, running the
    // identical reconciliation guard. Cached per-wallet (60s) — no continuous poll.
    // Rows that don't reconcile / have no fills stay "—" (honest); realizedPnl and
    // win rate are never touched. Stamped with an "as of" time for the UI.
    if (!rec && Array.isArray(profile.tradesClosed) && profile.tradesClosed.length > 0) {
      const { rec: onDemand, asOf } = await fetchWalletRecordOnDemand(address);
      if (onDemand) {
        enrichClosedTradesEntryExit(profile.tradesClosed, onDemand);
        attachClosedTradeFills(profile.tradesClosed, onDemand);   // reuse the SAME on-demand fills
      }
      profile.entryExitSource = 'ondemand';
      profile.entryExitAsOf   = asOf;
    }

    const session = await getServerSession(authOptions);
    const isPaid  = await getIsPaid(session);

    // Premium monetary fields nulled server-side for free/unauth (never $0).
    const body = redactForTier(
      { ok: true, address, updatedAt: raw.updatedAt, stale: age > STALE_MS, profile },
      'leaderboard-profile',
      isPaid,
    );

    return NextResponse.json(body);
  } catch {
    return NextResponse.json(
      { ok: false, address, profile: null, error: 'Leaderboard data unavailable — agent may be warming up.' },
      { status: 503 },
    );
  }
}
