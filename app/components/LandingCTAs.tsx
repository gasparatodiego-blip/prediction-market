'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

export default function LandingCTAs() {
  return (
    <div className="flex items-center gap-3 flex-wrap mb-5">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-mint-deep text-white font-body font-medium text-[12px] uppercase tracking-[0.1em] transition-colors duration-100 hover:bg-mint active:scale-[0.98] rounded-button"
      >
        See live opportunities
        <ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />
      </Link>
    </div>
  );
}
