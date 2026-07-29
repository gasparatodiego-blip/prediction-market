'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import RadarMark from './ui/RadarMark';
import RadarScope from './ui/RadarScope';
import ThemeToggle from './ThemeToggle';

// Nav trimmed to the Liquidity-Rewards product (UI only — every other route
// redirects via next.config.mjs; agents, APIs and page sources are all untouched).
// Retired tabs (prediction, carry, sport-arb, traders, portfolio, paper, plus the
// already-archived copy/cex/hft/lp/mm/whales/funding-arb/sports) now redirect to
// /dashboard/liquidity-rewards, so old bookmarks and the deep-links /api/ticker still
// emits land on Rewards instead of 404ing. Reversible: restoring a tab is one nav
// line here plus deleting its redirect.
//   '/dashboard' itself redirects to /dashboard/liquidity-rewards, so the logo and
//   any stray '/dashboard' link land on Rewards; the Overview hub page is kept but
//   superseded by that redirect.
//   'Maker' (/dashboard/maker) stays deliberately OUT of the nav: it is admin-gated
//   in middleware.ts (404 for non-admins), reachable only by direct URL.
//
// 'Alloca' (/dashboard/liquidity-rewards/allocate) was never in this list in any commit —
// the page has shipped since 4165285 but was only ever reachable by typing the URL, so it
// read as "the tab disappeared" when it had in fact never been linked. It is a PLANNING
// page (RewardsAllocatePanel builds no order, signs nothing, places nothing), so linking
// it adds no trading surface.
//
// `exact` exists because isActive() is a prefix match: without it, '/dashboard/liquidity-
// rewards' would also light up while on the /allocate child, showing two active tabs.
const NAV_LINKS = [
  { href: '/dashboard/liquidity-rewards',          label: 'Rewards', exact: true },
  { href: '/dashboard/liquidity-rewards/allocate', label: 'Alloca'  },
  { href: '/how-it-works',                         label: 'Guide'   },
];

export default function EdgeradarHeader() {
  const pathname  = usePathname();
  const { data: session } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (href: string, exact?: boolean) =>
    href === '/dashboard' || exact ? pathname === href : pathname.startsWith(href);

  const accountActive = pathname.startsWith('/dashboard/account');
  const initial = (session?.user?.name?.trim()?.[0] ?? session?.user?.email?.[0] ?? '?').toUpperCase();

  return (
    <header className="sticky top-0 z-50 bg-surface border-b border-line">
      <div className="dash-container px-4 flex items-center h-12 gap-6">

        {/* Logo */}
        <Link href="/dashboard" className="flex items-center gap-2 shrink-0">
          <RadarMark size={22} />
          <span className="font-display font-semibold text-[17px] text-ink tracking-tight leading-none">
            Edgeradar
          </span>
        </Link>

        {/* Nav — desktop */}
        <nav className="hidden md:flex items-stretch flex-1 overflow-x-auto">
          {NAV_LINKS.map(({ href, label, exact }) => {
            const active = isActive(href, exact);
            return (
              <Link
                key={href}
                href={href}
                className={[
                  'relative px-3 h-12 flex items-center font-body text-[13px] whitespace-nowrap transition-colors duration-100',
                  active ? 'text-mint-deep font-medium' : 'text-muted hover:text-ink-2',
                ].join(' ')}
              >
                {label}
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-mint-deep rounded-full" />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Live motif */}
        <div className="ml-auto flex items-center gap-3 shrink-0">
          <ThemeToggle />
          <RadarScope size={26} />
          <span className="font-body text-[11px] text-muted hidden sm:block">Live</span>

          {session?.user && (
            <Link
              href="/dashboard/account"
              title="Account"
              className={[
                'hidden md:flex items-center justify-center w-7 h-7 rounded-full font-body text-[11px] font-semibold transition-colors duration-100',
                accountActive
                  ? 'bg-mint-deep text-white'
                  : 'bg-mint-tint text-mint-deep hover:bg-mint/30',
              ].join(' ')}
            >
              {initial}
            </Link>
          )}
        </div>

        {/* Hamburger — mobile */}
        <button
          className="md:hidden ml-2 p-1.5 border border-line rounded-button text-muted hover:text-ink-2 hover:border-mint/40 transition-colors duration-100"
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
        <div className="md:hidden border-t border-line bg-surface">
          {NAV_LINKS.map(({ href, label, exact }) => {
            const active = isActive(href, exact);
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setMenuOpen(false)}
                className={[
                  'flex items-center gap-2.5 px-4 py-3 font-body text-[13px] border-b border-line/50 transition-colors duration-100',
                  active
                    ? 'text-mint-deep font-medium bg-mint-tint/40'
                    : 'text-muted hover:text-ink-2 hover:bg-bg-soft',
                ].join(' ')}
              >
                {active && (
                  <span className="w-1.5 h-1.5 rounded-full bg-mint-deep flex-shrink-0" aria-hidden />
                )}
                {label}
              </Link>
            );
          })}
          {session?.user && (
            <Link
              href="/dashboard/account"
              onClick={() => setMenuOpen(false)}
              className={[
                'flex items-center gap-2.5 px-4 py-3 font-body text-[13px] border-b border-line/50 transition-colors duration-100',
                accountActive
                  ? 'text-mint-deep font-medium bg-mint-tint/40'
                  : 'text-muted hover:text-ink-2 hover:bg-bg-soft',
              ].join(' ')}
            >
              {accountActive && (
                <span className="w-1.5 h-1.5 rounded-full bg-mint-deep flex-shrink-0" aria-hidden />
              )}
              Account
            </Link>
          )}
        </div>
      )}
    </header>
  );
}
