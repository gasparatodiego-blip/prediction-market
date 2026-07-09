'use client';

import Link from 'next/link';
import { Lock } from 'lucide-react';

// Server-side paid-gating (lib/paid-gating.ts) nulls sensitive numeric fields
// for free/no-session users. These are the ONLY two client-side renderers for
// that null state — never render "null"/"NaN"/"$0"/"undefined" directly.

interface RedactedProps<T> {
  /** Raw field straight from the API response — null/undefined means the
   *  server redacted it (free tier) OR, for a paid user, that the field is
   *  genuinely not measured (see `isPaid`). A present value is always real. */
  value: T | null | undefined;
  /** Only invoked when value is non-null — safe to format/compute inside. */
  children: (value: T) => React.ReactNode;
  className?: string;
  /** True for a PAID user. A paid user is never behind the paywall, so a
   *  null/undefined value here is an HONEST "not measured" (e.g. capacity the
   *  guardian suppressed because it was OI/proxy-derived, not a real book-walk)
   *  — render `nullDisplay` ("—"), never the upgrade lock. Default false → the
   *  free-tier lock, unchanged. */
  isPaid?: boolean;
  /** What a paid user sees when the value is genuinely null. Default "—". */
  nullDisplay?: React.ReactNode;
}

/** Inline replacement for a single redacted number/string — blurred dots + lock,
 *  links to /dashboard/upgrade. Sized to sit inline with surrounding text.
 *  For a paid user (`isPaid`), a null value is honest "not measured" → "—". */
export function Redacted<T>({ value, children, className = '', isPaid = false, nullDisplay = '—' }: RedactedProps<T>) {
  if (value !== null && value !== undefined) {
    return <>{children(value)}</>;
  }
  // Paid user: not a paywall — the field is genuinely null/not-measured.
  if (isPaid) {
    return <span className={`text-muted ${className}`.trim()}>{nullDisplay}</span>;
  }
  return (
    <Link
      href="/dashboard/upgrade"
      title="Upgrade to see this number"
      className={`
        inline-flex items-center gap-1 align-middle
        rounded-sm px-1.5 py-[1px]
        bg-line/70 hover:bg-line
        transition-colors
        ${className}
      `.replace(/\s+/g, ' ').trim()}
    >
      <span className="blur-[3px] select-none text-ink/60 tabular-nums">••••</span>
      <Lock className="w-2.5 h-2.5 text-muted shrink-0" strokeWidth={2.5} />
    </Link>
  );
}

/** Block-level placeholder for a whole redacted feed/array (server sent the
 *  entire field as null — e.g. lp.history, copy.recentAlerts for free tier). */
export function RedactedPanel({
  label = 'This feed is available on Pro',
  className = '',
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={`
        flex flex-col items-center justify-center gap-2
        py-10 px-6 text-center
        border border-line rounded-card bg-surface/60
        ${className}
      `.replace(/\s+/g, ' ').trim()}
    >
      <Lock className="w-4 h-4 text-muted" strokeWidth={2} />
      <p className="font-body text-[11px] text-muted">{label}</p>
      <Link
        href="/dashboard/upgrade"
        className="font-body text-[10px] text-mint hover:text-mint-deep transition-colors underline underline-offset-2"
      >
        Upgrade to unlock
      </Link>
    </div>
  );
}
