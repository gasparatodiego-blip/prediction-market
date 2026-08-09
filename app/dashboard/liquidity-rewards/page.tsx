// Il pannello di ARMING che stava qui sopra è stato rimosso il 9 agosto 2026 insieme al motore
// automatico: i comandi dell'operatore sono ora due soli — AVVIA/FERMA e KILL — e vivono dentro la
// console, con la barra KILL renderizzata FUORI dalle schede proprio perché resti raggiungibile da
// ogni sezione senza dover prima trovare la scheda giusta.
import LiquidityRewardsConsole from '@/app/components/LiquidityRewardsConsole';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Liquidity rewards · console maker — Edgeradar',
  description:
    'Una sola pagina: riepilogo, mercati, posizioni, ordini manuali, allocazione e regole del programma premi di Polymarket. Ogni cifra letta dal venue o dal feed reale.',
};

/**
 * /dashboard/liquidity-rewards — ONE URL, SIX SECTIONS.
 *
 * Riepilogo · Mercati · Posizioni · Ordini manuali · Ottimizza capitale · Regole are tabs inside
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
    <LiquidityRewardsConsole initialTab={searchParams?.tab} />
  );
}
