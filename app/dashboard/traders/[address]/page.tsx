// Per-trader detail page — always-fresh, real-time trade feed reconstructed from
// REAL public Polymarket data (agent30 live CLOB WS + keyless Data-API resync).
// Public page (no login wall); premium monetary fields are redacted server-side
// for free/unauth via lib/paid-gating.ts ('trader-feed'). All P&L is honestly
// labelled (unrealized mark-to-mid vs realized vs settled) and every number is a
// real fill / real Data-API read — nothing is fabricated.
import TraderDetail from '@/components/traders/TraderDetail';

export const dynamic = 'force-dynamic';

export default function TraderDetailPage({ params }: { params: { address: string } }) {
  return <TraderDetail address={(params.address || '').toLowerCase()} />;
}
