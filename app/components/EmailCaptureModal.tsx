'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, X } from 'lucide-react';

interface Props {
  open:        boolean;
  source:      string;
  destination: string;
  onClose:     () => void;
}

type Status = 'idle' | 'submitting' | 'success' | 'error';

export default function EmailCaptureModal({ open, source, destination, onClose }: Props) {
  const router                    = useRouter();
  const [email,  setEmail]        = useState('');
  const [status, setStatus]       = useState<Status>('idle');
  const [errMsg, setErrMsg]       = useState('');
  const inputRef                  = useRef<HTMLInputElement>(null);

  // Reset + focus when modal opens
  useEffect(() => {
    if (open) {
      setEmail('');
      setStatus('idle');
      setErrMsg('');
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Auto-navigate after success confirmation
  useEffect(() => {
    if (status !== 'success') return;
    const t = setTimeout(() => router.push(destination), 800);
    return () => clearTimeout(t);
  }, [status, router, destination]);

  // Esc to close (unless already navigating)
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status !== 'success') onClose();
    },
    [onClose, status],
  );
  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, handleKey]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status === 'submitting' || status === 'success') return;
    setStatus('submitting');
    setErrMsg('');

    try {
      const res  = await fetch('/api/leads', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim(), source }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'Failed to save');
      setStatus('success');
    } catch (err: unknown) {
      setStatus('error');
      setErrMsg(err instanceof Error ? err.message : 'Something went wrong — try again.');
    }
  };

  // "Skip for now" — immediately navigates, no email saved
  const skip = () => router.push(destination);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      aria-modal="true"
      role="dialog"
      aria-labelledby="modal-heading"
      onClick={e => {
        if (e.target === e.currentTarget && status !== 'success') onClose();
      }}
    >
      <div className="relative bg-bg-panel border border-border w-full max-w-md mx-4 p-6 shadow-[0_24px_64px_rgba(0,0,0,0.6)]">

        {/* X close button */}
        {status !== 'success' && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-3 right-3 p-1.5 text-text-muted/60 hover:text-text-primary transition-colors duration-100"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        )}

        {status === 'success' ? (
          <div className="text-center py-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-positive mb-3">
              ✓ YOU'RE IN
            </div>
            <p className="font-mono text-[12px] text-text-secondary leading-relaxed">
              We'll notify you when alerts go live.
            </p>
            <p className="font-mono text-[10px] text-text-muted/60 mt-4">
              Taking you there now…
            </p>
          </div>
        ) : (
          <>
            {/* Badge */}
            <div className="mb-4">
              <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-text-muted border border-border px-2 py-[4px]">
                PRE-LAUNCH
              </span>
            </div>

            <h2
              id="modal-heading"
              className="font-mono font-semibold text-[18px] uppercase tracking-[0.04em] text-text-primary mb-2"
            >
              Get Early Access
            </h2>

            <p className="font-mono text-[11px] text-text-secondary leading-[1.7] mb-5">
              Drop your email — we'll alert you when the engine goes live.
            </p>

            <form onSubmit={handleSubmit} noValidate>
              <input
                ref={inputRef}
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={e => {
                  setEmail(e.target.value);
                  if (status === 'error') setStatus('idle');
                }}
                disabled={status === 'submitting'}
                className="w-full bg-bg-elevated border border-border font-mono text-[12px] text-text-primary placeholder:text-text-muted/35 px-3 py-2.5 mb-3 focus:outline-none focus:border-accent disabled:opacity-50 transition-colors duration-100"
              />

              {status === 'error' && (
                <p className="font-mono text-[10px] text-negative mb-3">{errMsg}</p>
              )}

              <button
                type="submit"
                disabled={status === 'submitting' || email.trim().length === 0}
                className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-accent text-white font-mono font-medium text-[12px] uppercase tracking-[0.1em] transition-colors duration-100 hover:bg-accent-bright active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status === 'submitting' ? 'SAVING…' : 'GET ACCESS'}
                {status !== 'submitting' && <ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />}
              </button>
            </form>

            {/* Skip — always visible, never blocked */}
            <div className="mt-5 text-center">
              <button
                onClick={skip}
                className="font-mono text-[10px] text-text-muted/45 hover:text-text-muted transition-colors duration-100 underline underline-offset-2"
              >
                Skip for now →
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
