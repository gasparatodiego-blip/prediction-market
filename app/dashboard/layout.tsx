import TerminalHeader from '@/app/components/TerminalHeader';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg-base text-text-primary">
      <TerminalHeader />
      {children}
    </div>
  );
}
