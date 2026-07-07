'use client';

// InfoTip — a small, tap-friendly info popover for "i" icons.
// Works on mobile (tap toggles), dismisses on outside tap / Escape / scroll,
// and is viewport-clamped via fixed positioning so it never overflows the
// screen edge — even on a 360px-wide device. No external deps.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';

const POPOVER_W = 260; // px; clamped to viewport below
const MARGIN = 8;      // px gutter from the viewport edge

export default function InfoTip({
  label,
  children,
  size = 13,
}: {
  label: string;           // accessible name, e.g. "About hide high news-risk"
  children: React.ReactNode; // popover body
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Position the popover in viewport (fixed) coords, clamped to stay on-screen.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const width = Math.min(POPOVER_W, vw - MARGIN * 2);
    const center = r.left + r.width / 2;
    const left = Math.max(MARGIN, Math.min(center - width / 2, vw - width - MARGIN));
    setPos({ top: r.bottom + 6, left, width });
  }, [open]);

  // Dismiss on outside tap, Escape, or scroll/resize.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onMove = () => setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(v => !v); }}
        className={`inline-flex items-center justify-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-mint-deep/50 ${open ? 'text-mint-deep' : 'text-muted hover:text-ink-2'}`}
      >
        <Info size={size} />
      </button>
      {open && pos && (
        <div
          ref={popRef}
          role="tooltip"
          className="fixed z-50 rounded-button bg-surface shadow-lg border border-line px-3 py-2.5 font-body text-[11px] text-ink-2 leading-relaxed"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {children}
        </div>
      )}
    </>
  );
}
