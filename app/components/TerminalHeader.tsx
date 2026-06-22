'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_LINKS = [
  { href: '/dashboard',                  label: 'DASHBOARD'     },
  { href: '/dashboard/prediction',       label: 'PREDICTION'    },
  { href: '/dashboard/funding-arb',       label: 'FUNDING ARB'   },
  { href: '/dashboard/carry',            label: 'CARRY'         },
  { href: '/dashboard/liquidity-rewards', label: 'REWARDS'      },
  { href: '/dashboard/traders',           label: 'TRADERS'       },
  { href: '/dashboard/portfolio',        label: 'PORTFOLIO'     },
];

export default function TerminalHeader() {
  const pathname = usePathname();
  const [time, setTime] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const fmt = () => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      setTime(`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`);
    };
    fmt();
    const t = setInterval(fmt, 1000);
    return () => clearInterval(t);
  }, []);

  const isActive = (href: string) =>
    href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-50 bg-bg-panel border-b border-border">
      <div className="max-w-[1600px] mx-auto px-4 flex items-center h-10 gap-6">

        {/* Logo */}
        <Link href="/dashboard" className="flex items-baseline gap-2 shrink-0">
          <span className="font-mono font-bold text-sm tracking-widest bg-brand-gradient bg-clip-text text-transparent">
            ARBSCANNER
          </span>
          <span className="font-mono text-[10px] text-text-secondary tracking-wide hidden sm:block">
            MULTI-STRATEGY ARB PLATFORM
          </span>
        </Link>

        {/* Nav — desktop */}
        <nav className="hidden md:flex items-stretch flex-1">
          {NAV_LINKS.map(({ href, label }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                className={`relative px-3 h-10 flex items-center font-mono text-[11px] uppercase tracking-widest transition-colors duration-100
                  ${active ? 'text-accent' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {label}
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Live status strip */}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse-slow" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-accent">LIVE</span>
          <span className="font-mono text-[11px] text-text-muted tabular-nums w-[58px]">{time}</span>
        </div>

        {/* Hamburger — mobile */}
        <button
          className="md:hidden ml-2 p-1.5 border border-border bg-bg-elevated text-text-secondary hover:border-accent/40 hover:text-text-primary transition-colors duration-100 rounded-sm"
          onClick={() => setMenuOpen(v => !v)}
          aria-label="Toggle navigation menu"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d={menuOpen ? 'M6 18L18 6M6 6l12 12' : 'M4 6h16M4 12h16M4 18h16'} />
          </svg>
        </button>
      </div>

      {/* Mobile nav dropdown */}
      {menuOpen && (
        <div className="md:hidden border-t border-border bg-bg-panel">
          {NAV_LINKS.map(({ href, label }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setMenuOpen(false)}
                className={`flex items-center gap-2 px-4 py-2.5 font-mono text-[11px] uppercase tracking-widest border-b border-border/50 transition-colors duration-100
                  ${active
                    ? 'text-accent bg-accent/5'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'}`}
              >
                {active && <span className="text-accent">›</span>}
                {label}
              </Link>
            );
          })}
        </div>
      )}
    </header>
  );
}
