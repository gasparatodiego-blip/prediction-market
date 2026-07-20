import SportArbLive from '@/app/components/SportArbLive';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sport arbitrage · live — Edgeradar',
  description:
    'Live cross-venue sports crossings, net of all fees. Stale-leg pairings are filtered out, never shown as edge.',
};

export default function SportArbPage() {
  return <SportArbLive />;
}
