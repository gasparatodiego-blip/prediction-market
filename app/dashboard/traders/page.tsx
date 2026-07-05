// Top Traders dashboard — per-trader leaderboard + profile + movements + bots/HFT,
// consuming agent20 schema v2 (/api/leaderboard + /api/leaderboard/profile/[addr]).
// Public page (no login wall); premium monetary fields are redacted server-side
// for free/unauth via lib/paid-gating.ts. Copy slots are signal-follow reservations
// only — no trade executes here (that is a separate, hardening-gated commit).
import TradersApp from '@/components/traders/TradersApp';

export const dynamic = 'force-dynamic';

export default function TradersPage() {
  return <TradersApp />;
}
