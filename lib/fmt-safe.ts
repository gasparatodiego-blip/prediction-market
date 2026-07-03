// lib/fmt-safe.ts — null-safe number formatters.
//
// Server-side paid-gating (lib/paid-gating.ts) nulls sensitive fields for free
// users. Anywhere a formatted number must live inside a plain string (a prop
// that can't hold JSX, e.g. StatCard's `value`, chart series, table cell text)
// use these instead of raw .toFixed()/.toLocaleString() — they return a
// placeholder instead of "NaN"/"$NaN" when the input is null/undefined.
// For JSX contexts, prefer <Redacted> (app/components/ui/Redacted.tsx) — it
// renders the blur/lock/CTA instead of this plain-text placeholder.

export const REDACTED_PLACEHOLDER = '•••';

function isNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function safeFixed(n: number | null | undefined, dec = 1): string {
  return isNum(n) ? n.toFixed(dec) : REDACTED_PLACEHOLDER;
}

export function safePct(n: number | null | undefined, dec = 1): string {
  return isNum(n) ? `${n.toFixed(dec)}%` : REDACTED_PLACEHOLDER;
}

export function safeUsd(n: number | null | undefined, dec = 2): string {
  return isNum(n)
    ? `$${n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}`
    : REDACTED_PLACEHOLDER;
}

export function safeNum(n: number | null | undefined, dec = 0): string {
  return isNum(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })
    : REDACTED_PLACEHOLDER;
}

/** For chart/series inputs where a null must become a hole in the line, not a
 *  fabricated zero — pass through null so the charting lib skips the point. */
export function safeChartNum(n: number | null | undefined): number | null {
  return isNum(n) ? n : null;
}
