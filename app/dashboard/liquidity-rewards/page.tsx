import LiquidityRewardsConsole from '@/app/components/LiquidityRewardsConsole';
// Operator-only arming + KILL console, unchanged and deliberately kept ABOVE the tabs: the kill switch
// must be reachable from every section without first finding the right tab. It self-hides for non-admins
// (it probes the admin-gated /api/maker/*), so the public page is unaffected.
import MakerArmingPanel from '@/app/components/MakerArmingPanel';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Liquidity rewards · console maker — Edgeradar',
  description:
    'Una sola pagina: riepilogo, mercati, posizioni, ordini manuali, allocazione e regole del programma premi di Polymarket. Ogni cifra letta dal venue o dal feed reale.',
};

/**
 * /dashboard/liquidity-rewards — ONE URL, SIX SECTIONS.
 *
 * Riepilogo · Mercati · Posizioni · Ordini manuali · Alloca capitale · Regole are tabs inside
 * LiquidityRewardsConsole, held in client state: switching section never changes the URL and never
 * refetches. `?tab=` is read ONCE at mount, only so the legacy /allocate route can redirect straight to
 * its section; nothing on the page ever writes it back.
 *
 * The console is operator-only and self-hiding: /api/maker/board is admin-gated by middleware, and a
 * visitor without an admin session gets the unchanged PUBLIC rewards board instead. This rebuild
 * therefore takes nothing away from the public page.
 *
 * Polymarket only — the aggregation drops Kalshi at the source (lib/maker/operator-board).
 */
export default function LiquidityRewardsPage({
  searchParams,
}: {
  searchParams?: { tab?: string };
}) {
  return (
    <>
      <MakerArmingPanel />
      <LiquidityRewardsConsole initialTab={searchParams?.tab} />
    </>
  );
}
