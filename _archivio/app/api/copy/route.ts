import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

export const dynamic = 'force-dynamic';

const WATCHLIST_FILE   = path.join(process.cwd(), 'data/copy-watchlist.json');
const STATE_FILE       = '/tmp/copy-watcher.json';
const LEADERBOARD_FILE = '/tmp/leaderboard.json';
const MAX_WALLETS      = 50;
const AGENT_STALE_MS   = 10 * 60_000;  // 10 min

interface WatchEntry {
  wallet:        string;
  name:          string;
  category:      string;
  followedAt:    number;
  alertsEnabled: boolean;
}

function readWatchlist(): WatchEntry[] {
  try { return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')).wallets ?? []; }
  catch { return []; }
}

function writeWatchlist(wallets: WatchEntry[]) {
  const dir = path.dirname(WATCHLIST_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = WATCHLIST_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ wallets, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, WATCHLIST_FILE);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function buildLeaderboardMap() {
  try {
    const lb  = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    const map: Record<string, any> = {};
    for (const rows of Object.values(lb.categories ?? {}) as any[][]) {
      for (const t of rows) { if (!map[t.wallet]) map[t.wallet] = t; }
    }
    return map;
  } catch { return {}; }
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET() {
  const wallets = readWatchlist();
  const state   = readState();
  const lbMap   = buildLeaderboardMap();

  const staleMs = state ? Date.now() - new Date(state.updatedAt ?? 0).getTime() : Infinity;
  const online  = staleMs < AGENT_STALE_MS;

  const enriched = wallets.map(w => {
    const lb = lbMap[w.wallet] ?? {};
    return {
      ...w,
      pnlUsdc:         lb.pnlUsdc         ?? null,
      winRate:         lb.winRate          ?? null,
      resolvedMarkets: lb.resolvedMarkets  ?? null,
      volumeUsdc:      lb.volumeUsdc       ?? null,
      lastActive:      lb.lastActive       ?? null,
      wins:            lb.wins             ?? null,
      losses:          lb.losses           ?? null,
    };
  });

  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);
  const body    = redactForTier({
    ok:               online || wallets.length > 0,
    online,
    staleMinutes:     state ? Math.floor(staleMs / 60_000) : null,
    walletsMonitored: state?.walletsMonitored ?? 0,
    recentAlerts:     state?.recentAlerts ?? [],
    wallets:          enriched,
    updatedAt:        state?.updatedAt ?? null,
    maxWallets:       MAX_WALLETS,
  }, 'copy', isPaid);

  return NextResponse.json(body);
}

// ── POST — actions: follow | unfollow | toggle_alerts ─────────────────────────
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const action    = (body.action ?? '').trim();
  const rawWallet = (body.wallet ?? '').trim().toLowerCase();

  if (!rawWallet.match(/^0x[0-9a-f]{10,}/i)) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }

  const wallets = readWatchlist();

  if (action === 'follow') {
    if (wallets.length >= MAX_WALLETS)
      return NextResponse.json({ error: `Max ${MAX_WALLETS} wallets` }, { status: 400 });
    if (wallets.find(w => w.wallet === rawWallet))
      return NextResponse.json({ ok: true, already: true, count: wallets.length });

    wallets.push({
      wallet:        rawWallet,
      name:          String(body.name     ?? '').slice(0, 50),
      category:      String(body.category ?? 'Unknown').slice(0, 30),
      followedAt:    Math.floor(Date.now() / 1000),
      alertsEnabled: true,
    });
    writeWatchlist(wallets);
    return NextResponse.json({ ok: true, count: wallets.length });
  }

  if (action === 'unfollow') {
    writeWatchlist(wallets.filter(w => w.wallet !== rawWallet));
    return NextResponse.json({ ok: true, count: wallets.filter(w => w.wallet !== rawWallet).length });
  }

  if (action === 'toggle_alerts') {
    const entry = wallets.find(w => w.wallet === rawWallet);
    if (!entry) return NextResponse.json({ error: 'not following' }, { status: 404 });
    entry.alertsEnabled = !entry.alertsEnabled;
    writeWatchlist(wallets);
    return NextResponse.json({ ok: true, alertsEnabled: entry.alertsEnabled });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
