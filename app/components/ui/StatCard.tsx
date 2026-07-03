import type { ReactNode } from 'react';

interface StatCardProps {
  label:     string;
  /** Usually a string — or a <Redacted> blur/CTA node for a free-tier value */
  value:     ReactNode;
  note?:     string;
  /** Secondary caption — caveats, rate labels, methodology notes. Clearly demoted. */
  demoted?:  string;
  className?: string;
}

export default function StatCard({
  label,
  value,
  note,
  demoted,
  className = '',
}: StatCardProps) {
  return (
    <div className={`rounded-card shadow-card bg-surface px-5 py-5 ${className}`}>

      {/* Small muted label */}
      <p className="font-body text-[11px] uppercase tracking-wide text-muted mb-2">
        {label}
      </p>

      {/* Primary value — dominates the card */}
      <p
        className="font-display font-bold text-ink leading-none tracking-tight"
        style={{ fontSize: 33 }}
      >
        {value}
      </p>

      {/* One-line contextual note */}
      {note && (
        <p className="font-body text-sm text-ink-2 mt-2 leading-snug">
          {note}
        </p>
      )}

      {/* Demoted caveat line — clearly secondary via smaller size + muted color */}
      {demoted && (
        <p className="font-body text-[11px] text-muted mt-1.5 leading-snug">
          {demoted}
        </p>
      )}

    </div>
  );
}
