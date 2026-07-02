import type { EventPlatform } from './types';

export const PLATFORM_LABELS: Record<string, string> = {
  kalshi:     'Kalshi',
  polymarket: 'Polymarket',
  predictit:  'PredictIt',
  manifold:   'Manifold',
  oddsapi:    'Odds API',
};

export function platformLabel(p: string): string {
  return PLATFORM_LABELS[p?.toLowerCase()] ?? p;
}

export function formatCents(price: number | null | undefined): string {
  if (price == null || !isFinite(price)) return '—';
  return `${Math.round(price * 100)}¢`;
}

function abbreviateNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return Math.round(n).toLocaleString();
}

// Volume column for the event comparator's platform table. Only ever renders
// a "$" figure when the source unit is genuinely USD (volumeUsd, or a
// volumeNative whose own unit says "usd") — every other native unit
// (contracts, mana, ...) is shown with its own unit label so it's never
// mistaken for a dollar amount.
export function formatVolume(p: Pick<EventPlatform, 'volumeUsd' | 'volumeNative'>): string {
  if (typeof p.volumeUsd === 'number') return `$${abbreviateNum(p.volumeUsd)}`;
  if (p.volumeNative) {
    const { amount, unit } = p.volumeNative;
    if (unit === 'usd') return `$${abbreviateNum(amount)}`;
    const n = abbreviateNum(amount);
    if (unit === 'mana') return `${n} play`;
    if (unit === 'contracts') return `${n} contracts`;
    return `${n} ${unit}`;
  }
  return '—';
}

export function formatResolutionDate(iso: string | null | undefined): string {
  if (!iso) return 'date unknown';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'date unknown';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
