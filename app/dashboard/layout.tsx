import EdgeradarHeader from '@/app/components/EdgeradarHeader';
import GlobalFreshnessBanner from '@/app/components/GlobalFreshnessBanner';
import OnboardingModal from '@/app/components/OnboardingModal';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen text-ink"
      style={{
        background:
          'radial-gradient(circle at 50% -10%, rgba(15,190,130,.05), transparent 60%), #F5F8F6',
      }}
    >
      {/* Rules 48/62 — one calm global "dati non aggiornati" banner when the whole
          pipeline is stale. Display-only; never hides the last-good data below. */}
      <GlobalFreshnessBanner />
      <EdgeradarHeader />
      {children}
      <OnboardingModal />
    </div>
  );
}
