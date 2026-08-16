'use client';

// InfoDot — a small ⓘ dot placed next to jargon anywhere in the app. It is a
// thin wrapper over the existing accessible <InfoTip> popover primitive; the
// definition text comes ONLY from the shared glossary (lib/glossary.ts), so the
// tooltip can never drift from the /how-it-works page.
//
// Purely additive: it renders one inline dot and changes no data, number, or
// layout beyond the dot itself.

import InfoTip from './InfoTip';
import { GLOSSARY, type GlossaryTerm } from '@/lib/glossary';

export default function InfoDot({
  term,
  size = 12,
  className = '',
}: {
  term: GlossaryTerm;
  size?: number;
  className?: string;
}) {
  const entry = GLOSSARY[term];
  if (!entry) return null; // unknown key — fail closed, render nothing

  return (
    <span className={`inline-flex items-center align-middle ${className}`}>
      <InfoTip label={`What is ${entry.title}?`} size={size}>
        <span className="block font-body">
          <span className="block font-semibold text-ink text-[11px] mb-0.5">
            {entry.title}
          </span>
          <span className="block text-ink-2 text-[11px] leading-relaxed">
            {entry.short}
          </span>
        </span>
      </InfoTip>
    </span>
  );
}
