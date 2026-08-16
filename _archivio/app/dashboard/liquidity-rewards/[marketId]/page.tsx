import MarketTerminal from '@/app/components/MarketTerminal';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Mercato · liquidity rewards — Edgeradar',
  description:
    'One screen for one reward market: the worth-it verdict at your size, the configuration, a single '
    + 'order book with the reward band, the per-order rules the maker actually reads, the per-market '
    + 'collateral ceiling, and the four execution gates ending in the two-step ARM.',
};

// Server wrapper only. This route USED to be a 2,000-line client page that answered "what would I earn",
// while "the book" and "the market card" were two further pages the operator had to leave for — so the
// decision, the evidence for it and the controls that act on it never appeared together, and nobody ever
// arrived at placing anything. All three are now the same screen (app/components/MarketTerminal), and
// /event redirects here rather than being a fourth place to look.
export default function MarketPage({ params }: { params: { marketId: string } }) {
  return <MarketTerminal marketId={decodeURIComponent(params.marketId)} />;
}
