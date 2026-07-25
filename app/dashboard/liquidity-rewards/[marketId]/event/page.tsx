import EventTerminal from '@/app/components/EventTerminal';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Scheda mercato · liquidity rewards — Edgeradar',
  description:
    'Read-only data terminal for one reward market: identifiers, venue rules, the effective reward band, the live CLOB book, and the wallet’s on-chain position. Declares; never advises.',
};

// Server wrapper only — every read happens in the client terminal against /api/rewards/event(+/book),
// which is where tier redaction and the read-only chain calls live.
export default function EventPage({ params }: { params: { marketId: string } }) {
  return <EventTerminal marketId={decodeURIComponent(params.marketId)} />;
}
