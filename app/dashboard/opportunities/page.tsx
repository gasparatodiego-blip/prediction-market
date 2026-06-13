import OpportunitiesPanel from '@/app/components/OpportunitiesPanel';

export default function OpportunitiesPage() {
  return (
    <div className="max-w-[1100px] mx-auto px-4 py-6">
      <div className="mb-5">
        <h1 className="font-mono text-sm uppercase tracking-widest text-text-primary">
          OPPORTUNITIES
        </h1>
        <p className="font-mono text-[10px] text-text-muted mt-0.5">
          CASHABLE · SIGNAL · SPORTS · RANKED BY ANNUALIZED ROI
        </p>
      </div>
      <OpportunitiesPanel />
    </div>
  );
}
