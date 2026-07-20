'use client';
import { useEffect, useState } from 'react';

// Small ☀/☾ Day|Night switch. State of record is the `data-theme` attribute on
// <html> (set by the server from the `theme` cookie). Clicking flips the
// attribute AND rewrites the cookie so the next SSR paint matches — CSS custom
// properties cascade from <html>, so every themed surface (native ds tabs,
// .dsskin list tabs, the landing) repaints live with no reload. A MutationObserver
// keeps multiple mounted toggles (landing nav + dashboard header) in sync.
type Theme = 'day' | 'night';

function readTheme(): Theme {
  if (typeof document === 'undefined') return 'day';
  return document.documentElement.getAttribute('data-theme') === 'night' ? 'night' : 'day';
}

export default function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>('day');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setTheme(readTheme());
    const el = document.documentElement;
    const obs = new MutationObserver(() => setTheme(readTheme()));
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  const flip = () => {
    const next: Theme = readTheme() === 'night' ? 'day' : 'night';
    document.documentElement.setAttribute('data-theme', next);
    // 1-year persistent cookie so the server renders the same theme next load.
    document.cookie = `theme=${next}; path=/; max-age=31536000; samesite=lax`;
    setTheme(next);
  };

  // Render the day face until mounted so SSR/first-paint markup is stable; the
  // effect corrects it to the real attribute value immediately on mount.
  const isNight = mounted && theme === 'night';

  return (
    <button
      type="button"
      onClick={flip}
      aria-label={isNight ? 'Switch to day theme' : 'Switch to night theme'}
      title={isNight ? 'Night' : 'Day'}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 999,
        border: '1px solid var(--ds-border)',
        background: 'var(--ds-panel)',
        color: 'var(--ds-sub)',
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ fontSize: 13 }}>{isNight ? '☾' : '☀'}</span>
      <span>{isNight ? 'Night' : 'Day'}</span>
    </button>
  );
}
