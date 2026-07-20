import PredictionArb from '@/app/components/PredictionArb';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Prediction · cross-venue — Edgeradar',
  description:
    'Cross-venue prediction-market crossings, net of fees. One-time settlement, so no annualized figure is shown; mid-price venues are marked signal only.',
};

// Rebuilt on the shared ds card language. Reads the same /api/prediction route as the
// previous desk view — no API contract or number changed, only the presentation. The old
// filter-rich light-theme board remains in git history.
export default function PredictionPage() {
  return <PredictionArb />;
}
