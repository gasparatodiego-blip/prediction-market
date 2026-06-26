import type { ReactNode } from 'react';

interface PillProps {
  children: ReactNode;
  className?: string;
}

export default function Pill({ children, className = '' }: PillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-pill bg-mint-tint text-mint-deep font-body font-medium text-[10px] leading-none ${className}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-mint flex-shrink-0" aria-hidden />
      {children}
    </span>
  );
}
