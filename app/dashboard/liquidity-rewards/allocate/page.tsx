import RewardsAllocatePanel from '@/app/components/RewardsAllocatePanel';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Allocazione capitale · liquidity rewards — Edgeradar',
  description:
    'Inserisci un capitale e ottieni l’allocazione dell’ottimizzatore sui mercati, con la dimensione per-mercato corretta dalla profondità reale in-band. Piano, non un ordine.',
};

// PUBLIC page (no login wall, like the rest of the dashboard). It plans and displays only — see
// RewardsAllocatePanel: no order is ever constructed, signed, armed or placed from here.
export default function AllocatePage() {
  return <RewardsAllocatePanel />;
}
