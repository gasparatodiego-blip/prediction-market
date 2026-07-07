'use client';

// Shared "open on the source platform" deep-link — a small, distinct ↗ tap target.
// Renders a REAL anchor (new tab, noopener). Callers pass a URL already built from a
// real id via lib/platform-links.ts; when that builder returns null, the caller must
// render nothing (this component assumes a valid href). onClick stops propagation so
// it never triggers an enclosing card's tap-to-detail navigation.

import { ArrowUpRight } from 'lucide-react';

export function PlatformLink({
  href,
  label = 'platform',
  className = '',
  compact = false,
}: {
  href: string;
  label?: string;
  className?: string;
  compact?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Open on ${label}`}
      aria-label={`Open on ${label} (opens in a new tab)`}
      className={
        `inline-flex items-center gap-1 rounded-md border border-line bg-bg-soft text-muted ` +
        `hover:text-ink hover:border-ink-2/40 transition-colors focus:outline-none ` +
        `focus-visible:ring-2 focus-visible:ring-mint-deep/50 ` +
        (compact ? 'p-1 ' : 'px-1.5 py-1 ') +
        className
      }
    >
      <ArrowUpRight size={13} className="shrink-0" aria-hidden />
      {!compact && <span className="font-body text-[10.5px] leading-none">Open</span>}
    </a>
  );
}

export default PlatformLink;
