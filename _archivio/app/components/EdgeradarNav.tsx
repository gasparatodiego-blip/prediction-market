'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import RadarMark from '@/app/components/ui/RadarMark';
import Button from '@/app/components/ui/Button';

const NAV_LINKS = [
  { href: '#what-it-finds', label: 'What it finds' },
  { href: '#why-honest',    label: "Why it's honest" },
];

export default function EdgeradarNav() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <header className="sticky top-0 z-50 bg-surface/90 backdrop-blur-sm border-b border-line">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center h-14 gap-4">

        {/* Wordmark */}
        <Link
          href="/"
          className="flex items-center gap-2 flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50 rounded-sm"
        >
          <RadarMark size={22} />
          <span className="font-display font-bold text-ink text-[18px] tracking-tight">Edgeradar</span>
        </Link>

        {/* Nav links — desktop */}
        <nav className="hidden md:flex items-center gap-7 ml-8 flex-1" aria-label="Site navigation">
          {NAV_LINKS.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              className="font-body text-sm text-muted hover:text-ink transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50 rounded-sm"
            >
              {label}
            </a>
          ))}
        </nav>

        {/* CTAs — desktop */}
        <div className="hidden md:flex items-center gap-2 ml-auto">
          <Button variant="ghost" size="md" onClick={() => router.push('/auth/login')}>
            Sign in
          </Button>
          <Button variant="primary" size="md" onClick={() => router.push('/auth/register')}>
            Start free
          </Button>
        </div>

        {/* Hamburger — mobile */}
        <button
          className="md:hidden ml-auto p-2 text-muted hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50 rounded-sm"
          onClick={() => setOpen(v => !v)}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path
              strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d={open ? 'M6 18L18 6M6 6l12 12' : 'M4 6h16M4 12h16M4 18h16'}
            />
          </svg>
        </button>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="md:hidden border-t border-line bg-surface px-4 py-4 space-y-1" role="menu">
          {NAV_LINKS.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className="block font-body text-sm text-ink-2 hover:text-ink py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50 rounded-sm"
              role="menuitem"
            >
              {label}
            </a>
          ))}
          <div className="flex flex-col gap-2 pt-3 border-t border-line mt-3">
            <Button variant="ghost" size="md" onClick={() => { setOpen(false); router.push('/auth/login'); }}>
              Sign in
            </Button>
            <Button variant="primary" size="md" onClick={() => { setOpen(false); router.push('/auth/register'); }}>
              Start free
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
