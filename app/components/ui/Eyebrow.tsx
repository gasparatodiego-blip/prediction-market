import type { ReactNode } from 'react';

interface EyebrowProps {
  children: ReactNode;
  className?: string;
}

export default function Eyebrow({ children, className = '' }: EyebrowProps) {
  return (
    <p
      className={`font-body font-semibold text-[12px] uppercase tracking-[0.12em] text-mint-deep ${className}`}
    >
      {children}
    </p>
  );
}
