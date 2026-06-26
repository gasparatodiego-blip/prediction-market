import EdgeradarHeader from '@/app/components/EdgeradarHeader';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen text-ink"
      style={{
        background:
          'radial-gradient(circle at 50% -10%, rgba(15,190,130,.05), transparent 60%), #F5F8F6',
      }}
    >
      <EdgeradarHeader />
      {children}
    </div>
  );
}
