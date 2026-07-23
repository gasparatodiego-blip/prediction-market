import EdgeradarHeader from '@/app/components/EdgeradarHeader';
import GlobalFreshnessBanner from '@/app/components/GlobalFreshnessBanner';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen text-ink"
      style={{
        background:
          'radial-gradient(circle at 50% -10%, rgba(15,190,130,.05), transparent 60%), var(--ds-bg)',
      }}
    >
      {/* Rules 48/62 — one calm global "Data may be stale" banner when the whole
          pipeline is stale. Display-only; never hides the last-good data below. */}
      <GlobalFreshnessBanner />
      <EdgeradarHeader />
      {children}
    </div>
  );
}
