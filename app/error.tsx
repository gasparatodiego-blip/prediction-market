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
    <div className="min-h-screen bg-bg-base text-text-primary flex items-center justify-center px-6">
      <div className="max-w-md w-full border border-border bg-bg-panel p-8">
        <div className="font-mono text-[9px] uppercase tracking-widest text-warning/70 mb-4">
          RENDER ERROR
        </div>
        <h2 className="font-mono text-sm text-text-primary mb-3">
          Something went wrong loading this page.
        </h2>
        <p className="font-mono text-[10px] text-text-muted leading-relaxed mb-6">
          This is usually transient. Try refreshing — if it persists,
          the data agent feeding this page may be offline.
        </p>
        {error.digest && (
          <p className="font-mono text-[8px] text-text-muted/40 mb-5">
            ref: {error.digest}
          </p>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={reset}
            className="font-mono text-[10px] uppercase tracking-widest px-4 py-2 bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="font-mono text-[10px] uppercase tracking-widest px-4 py-2 border border-border text-text-muted hover:text-text-primary transition-colors"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
