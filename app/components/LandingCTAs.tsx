'use client';

import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import EmailCaptureModal from './EmailCaptureModal';

interface ModalState {
  source:      string;
  destination: string;
}

export default function LandingCTAs() {
  const [modal, setModal] = useState<ModalState | null>(null);

  return (
    <>
      <div className="flex items-center gap-3 flex-wrap mb-5">
        <button
          onClick={() => setModal({ source: 'opportunities', destination: '/dashboard/opportunities' })}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent text-white font-mono font-medium text-[12px] uppercase tracking-[0.1em] transition-colors duration-100 hover:bg-accent-bright active:scale-[0.98]"
        >
          See live opportunities
          <ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />
        </button>

        <button
          onClick={() => setModal({ source: 'funding', destination: '/dashboard/funding-arb' })}
          className="inline-flex items-center px-5 py-2.5 border border-border bg-bg-elevated text-text-secondary font-mono text-[12px] uppercase tracking-[0.1em] transition-colors duration-100 hover:border-accent/40 hover:text-text-primary"
        >
          Funding Monitor
        </button>
      </div>

      <EmailCaptureModal
        open={modal !== null}
        source={modal?.source ?? ''}
        destination={modal?.destination ?? ''}
        onClose={() => setModal(null)}
      />
    </>
  );
}
