import RewardsUnified from '@/app/components/RewardsUnified';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Liquidity rewards · maker — Edgeradar',
  description:
    'Quote both sides inside the reward band. Net $/day after estimated adverse selection, with the annualized run-rate demoted and capped.',
};

// Rebuilt on the shared ds card language. The previous filter-rich light-theme board is in
// git history; both read /api/rewards-unified and both compute through lib/rewards-estimate,
// so no number changed — only the presentation.
export default function LiquidityRewardsPage() {
  return <RewardsUnified />;
}
