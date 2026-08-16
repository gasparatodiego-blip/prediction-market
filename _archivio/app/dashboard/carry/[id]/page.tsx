import CarryPositionCalculator from '@/app/components/CarryPositionCalculator';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Carry position · calculator — Edgeradar',
  description:
    'If I enter now, exactly how much do I net? Itemised fees, net held to expiry, and an honest comparison against the risk-free rate.',
};

// Replaces the previous 503-line light-theme operation page with the approved calculator
// surface. The old view is in git history (commit 324479c^). Its EXECUTION_ENABLED safety
// gate is carried forward into the new component: auto-execute is an armed visual state,
// no order path, no account linking, no credential read.
export default function CarryDetailPage({ params }: { params: { id: string } }) {
  return <CarryPositionCalculator id={decodeURIComponent(params.id)} />;
}
