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
      <div className="border border-warning/30 bg-warning/5 px-5 py-5 max-w-lg">
        <div className="font-mono text-[9px] uppercase tracking-widest text-warning mb-3">
          PAGE ERROR
        </div>
        <p className="font-mono text-[11px] text-text-secondary leading-relaxed mb-4">
          This dashboard section failed to render. The data agent may be
          restarting — try again in a few seconds.
        </p>
        {error.digest && (
          <p className="font-mono text-[8px] text-text-muted/40 mb-4">
            ref: {error.digest}
          </p>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={reset}
            className="font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            Retry
          </button>
          <Link
            href="/dashboard"
            className="font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 border border-border/60 text-text-muted hover:text-text-primary transition-colors"
          >
            ← Back
          </Link>
        </div>
      </div>
    </div>
  );
}
