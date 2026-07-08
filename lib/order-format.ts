// order-format.ts — shared display helpers for the funding-arb & carry order
// (operation) pages. Extracted verbatim from the funding-arb order page so both
// pages format money, capacity, and payback identically (single source of truth).
// DISPLAY ONLY — none of these feed math or fabricate a value.

// Money: ≥$10k → "$12.3k", ≥$100 → "$120", else "$12.34". Signed.
export function fmtMoney(n: number): string {
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  if (abs >= 100)    return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

// Coin quantity: ≥1000 → 2dp, ≥1 → 4dp, else 6dp.
export function fmtQty(n: number): string {
  if (n >= 1_000) return n.toFixed(2);
  if (n >= 1)     return n.toFixed(4);
  return n.toFixed(6);
}

// Honest capacity display. Below the $500k ladder top the value is a real
// order-book estimate → "~$N". At/above the top rung the book is deeper than we
// measure → a truthful floor "$500k+". Never presents a hard cap as exact depth.
export const SIZE_LADDER_TOP_RUNG = 500_000;
export function fmtCapDisplay(n: number): string {
  if (n >= SIZE_LADDER_TOP_RUNG) return `$${Math.round(SIZE_LADDER_TOP_RUNG / 1_000)}k+`;
  return `~$${Math.round(n).toLocaleString('en-US')}`;
}

// Payback / duration formatter. Under 24h → "12h"; ≥24h → "2d 10h" (drops hours
// when exact → "3d"); missing/null → "—".
export function formatPayback(days: number | null | undefined): string {
  if (days == null || !isFinite(days)) return '—';
  const h = Math.round(days * 24);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24), r = h % 24;
  return r === 0 ? `${d}d` : `${d}d ${r}h`;
}
