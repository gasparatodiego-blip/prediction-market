'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[dashboard-error]', error);
  }, [error]);

  return (
    <div className="max-w-[1100px] mx-auto px-4 py-12">
      <div className="border border-gold/30 bg-gold/5 px-5 py-5 max-w-lg rounded-card">
        <div className="font-body text-[9px] uppercase tracking-widest text-gold mb-3">
          PAGE ERROR
        </div>
        <p className="font-body text-[11px] text-ink-2 leading-relaxed mb-4">
          This dashboard section failed to render. The data agent may be
          restarting — try again in a few seconds.
        </p>
        {error.digest && (
          <p className="font-mono text-[8px] text-muted/40 mb-4">
            ref: {error.digest}
          </p>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={reset}
            className="font-body text-[11px] font-medium uppercase tracking-wide px-3 py-1.5 bg-mint-deep text-white hover:bg-mint transition-colors rounded-button"
          >
            Retry
          </button>
          <Link
            href="/dashboard"
            className="font-body text-[11px] font-medium uppercase tracking-wide px-3 py-1.5 border border-line/60 text-muted hover:text-ink transition-colors rounded-button"
          >
            ← Back
          </Link>
        </div>
      </div>
    </div>
  );
}
