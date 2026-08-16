import CashCarryBasis from '@/app/components/CashCarryBasis';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Cash & carry · basis — Edgeradar',
  description:
    'Buy spot, short the dated future, hold to expiry. Net $/day after fees, executable basis from real bid/ask, compared against the risk-free rate.',
};

// Replaces the previous 780-line filter-rich desk view with the approved card surface.
// The old view remains in git history (commit 583d9c3^) if any of its filters are wanted
// back; the numbers it rendered came from the same /api/carry route this component reads,
// so no measurement changed — only the presentation.
export default function CarryPage() {
  return <CashCarryBasis />;
}
