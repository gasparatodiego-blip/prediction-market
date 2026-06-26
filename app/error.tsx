'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[page-error]', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-bg text-ink flex items-center justify-center px-6">
      <div className="max-w-md w-full border border-line bg-surface p-8 rounded-card shadow-card">
        <div className="font-body text-[9px] uppercase tracking-widest text-gold/70 mb-4">
          RENDER ERROR
        </div>
        <h2 className="font-display font-semibold text-sm text-ink mb-3">
          Something went wrong loading this page.
        </h2>
        <p className="font-body text-[11px] text-muted leading-relaxed mb-6">
          This is usually transient. Try refreshing — if it persists,
          the data agent feeding this page may be offline.
        </p>
        {error.digest && (
          <p className="font-mono text-[8px] text-muted/40 mb-5">
            ref: {error.digest}
          </p>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={reset}
            className="font-body text-[11px] font-medium uppercase tracking-wide px-4 py-2 bg-mint-deep text-white hover:bg-mint transition-colors rounded-button"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="font-body text-[11px] font-medium uppercase tracking-wide px-4 py-2 border border-line text-muted hover:text-ink transition-colors rounded-button"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
