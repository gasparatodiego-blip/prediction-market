'use client';
import React from 'react';

// Micro-badge stating, truthfully, whether the number above it was re-read from
// the venue's own public API and matched within tolerance. The timestamp is the
// REAL verifiedAt written by agent29-verifier (never fabricated). Tiny, muted,
// non-intrusive, mobile-safe.
//
// Statuses (from lib/display-sanity enforceVerified → row.__verify):
//   ok        → green  "✓ source-verified <age> ago"
//   stale     → amber  "⚠ stale — source unreachable"
//   verifying → muted  "verifying…"   (awaiting first / next source re-read)
// 'mismatch' rows are dropped server-side and never reach the card.
// 'confirmed' rows are backed by a real slip-walked order-book depth but were not
//   independently re-read this cycle (budget-capped verifier): we make no claim and
//   render NO badge, rather than a permanent, misleading "verifying…".

export type VerifyMeta = { status?: 'ok' | 'verifying' | 'stale' | 'mismatch' | 'confirmed'; verifiedAt?: number; ageMs?: number } | null | undefined;

function fmtAge(ms?: number): string {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

export function VerifyBadge({ v, className = '' }: { v: VerifyMeta; className?: string }) {
  const status = v?.status ?? 'verifying';
  if (status === 'mismatch') return null; // dropped upstream; defensive
  if (status === 'confirmed') return null; // real slip-walked depth, no independent re-read pending — make no claim

  let color = '#6b7787';
  let text = 'verifying…';
  let title = 'Awaiting an independent re-read from the venue’s public API';

  if (status === 'ok') {
    color = '#3fb950';
    const age = fmtAge(v?.ageMs);
    text = age ? `✓ source-verified ${age} ago` : '✓ source-verified';
    title = 'Re-read from the venue’s own public API and matched within tolerance';
  } else if (status === 'stale') {
    color = '#d29922';
    text = '⚠ stale — source unreachable';
    title = 'Could not re-read this value at the venue source — shown unverified';
  }

  return (
    <div
      className={`font-body inline-flex items-center gap-1 leading-none ${className}`}
      style={{ fontSize: 9, color, marginTop: 3, letterSpacing: 0.1 }}
      title={title}
    >
      {text}
    </div>
  );
}

export default VerifyBadge;
