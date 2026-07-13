'use client';

// OnboardingModal — a one-time welcome shown on first visit to the dashboard.
//
// Honest-engine + no-nag rules:
//  • Shows ONCE. A localStorage flag (display-only client pref, same guarded
//    pattern as funding-arb's EXCHANGES_STORAGE_KEY) records that it was seen.
//  • Never blocks work: Skip / X / Esc / backdrop all dismiss it, and dismissing
//    always sets the flag so it never reappears on its own.
//  • Reopenable on demand from the header "?" button, via the
//    'edgeradar:open-onboarding' window event (this bypasses the flag but does
//    not clear it — closing again is still a no-nag dismiss).
//  • Purely additive: changes no data, number, or gating.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { X, ArrowRight } from 'lucide-react';

const SEEN_KEY = 'edgeradar:onboarding-seen:v1';

const POINTS = [
  {
    head: 'Net $/day is the number we lead with',
    body: 'An estimate after fees and funding, at current conditions — a run-rate, never a guarantee.',
  },
  {
    head: 'Three honest tiers',
    body: 'Cashable (locked arbitrage), Arb soft (a real arb, but fragile), and Signal (favorable, yet a single bet that can still lose).',
  },
  {
    head: 'Too-good-to-be-true is suppressed',
    body: 'Unknowns show as “—”, nothing is fabricated, and implausible figures are held back rather than headlined.',
  },
];

export default function OnboardingModal() {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // First-visit check + reopen listener.
  useEffect(() => {
    let seen = true;
    try {
      seen = localStorage.getItem(SEEN_KEY) === '1';
    } catch {
      seen = true; // storage blocked → behave as "already seen", never nag
    }
    if (!seen) setOpen(true);

    const reopen = () => setOpen(true);
    window.addEventListener('edgeradar:open-onboarding', reopen);
    return () => window.removeEventListener('edgeradar:open-onboarding', reopen);
  }, []);

  // Dismiss = close AND record seen, so it never returns on its own.
  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* non-fatal — worst case it shows again next visit */
    }
    setOpen(false);
  }, []);

  // Esc closes; focus the close button when it opens.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => closeRef.current?.focus(), 50);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
  }, [open, dismiss]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-heading"
      onClick={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="relative bg-surface border border-line w-full max-w-md p-6 shadow-card rounded-card">
        <button
          ref={closeRef}
          onClick={dismiss}
          aria-label="Close"
          className="absolute top-3 right-3 p-1.5 text-muted/60 hover:text-ink transition-colors duration-100 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-mint-deep/50"
        >
          <X size={14} strokeWidth={1.5} />
        </button>

        <div className="mb-4">
          <span className="font-body text-[9px] uppercase tracking-[0.18em] text-mint-deep border border-mint/40 px-2 py-[4px] rounded-pill">
            WELCOME
          </span>
        </div>

        <h2
          id="onboarding-heading"
          className="font-display font-semibold text-[19px] text-ink mb-2"
        >
          Welcome to Edgeradar
        </h2>
        <p className="font-body text-[12px] text-ink-2 leading-relaxed mb-5">
          An honest edge scanner. Three quick things before you dive in:
        </p>

        <ul className="space-y-3 mb-6">
          {POINTS.map((p, i) => (
            <li key={i} className="flex gap-3">
              <span className="font-display font-bold text-[13px] text-mint-deep tabular-nums mt-[1px] shrink-0">
                {i + 1}
              </span>
              <span>
                <span className="block font-body font-semibold text-[12.5px] text-ink leading-snug">
                  {p.head}
                </span>
                <span className="block font-body text-[11.5px] text-ink-2 leading-relaxed mt-0.5">
                  {p.body}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-3">
          <button
            onClick={dismiss}
            className="font-body text-[12px] text-muted hover:text-ink-2 transition-colors duration-100 underline underline-offset-2"
          >
            Skip
          </button>
          <Link
            href="/how-it-works"
            onClick={dismiss}
            className="ml-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-mint-deep text-white font-body font-medium text-[12px] uppercase tracking-[0.1em] transition-colors duration-100 hover:bg-mint active:scale-[0.98] rounded-button"
          >
            Show me around
            <ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />
          </Link>
        </div>
      </div>
    </div>
  );
}
