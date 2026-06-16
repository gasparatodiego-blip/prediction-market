'use client';

import { useEffect, useRef, type PropsWithChildren } from 'react';

interface RevealProps {
  delay?: number;  // ms delay before the transition fires
}

export default function Reveal({ children, delay = 0 }: PropsWithChildren<RevealProps>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Honour reduced-motion: skip entirely
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // If already in viewport (above the fold), show immediately
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight - 40) {
      // above fold or very close — no reveal needed
      return;
    }

    el.classList.add('reveal-hidden');

    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => {
            el.classList.add('reveal-visible');
            obs.unobserve(el);
          }, delay);
        }
      },
      { threshold: 0.06 },
    );

    obs.observe(el);
    return () => obs.disconnect();
  }, [delay]);

  return <div ref={ref}>{children}</div>;
}
