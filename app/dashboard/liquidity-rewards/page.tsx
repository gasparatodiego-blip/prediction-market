import RewardsUnified from '@/app/components/RewardsUnified';
// Operator-only arming + KILL console. Self-hides for non-admins (probes the admin-gated /api/maker/*),
// so the public board is unchanged; the operator gets a persistent kill + arming control on this tab.
import MakerArmingPanel from '@/app/components/MakerArmingPanel';
// Operator-only MANUAL ORDERS console. Same admin gate, same self-hide behaviour: a non-admin visitor
// sees neither panel. It drives one market by hand, isolated from agent35 by the per-market manual-mode
// flag (lib/maker/manual-mode). Placement defaults to dry-run through its own MANUAL_ORDER_PLACEMENT
// switch, independent of the engine's MAKER_PLACEMENT.
import ManualOrdersPanel from '@/app/components/ManualOrdersPanel';

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
  return (
    <>
      <MakerArmingPanel />
      <ManualOrdersPanel />
      <RewardsUnified />
    </>
  );
}
