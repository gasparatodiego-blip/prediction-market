'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

// Global scroll-to-top on route change.
//
// The app scrolls the WINDOW/document — the dashboard shell is a `min-h-screen`
// div (root <body> has no overflow), so content grows the document rather than an
// inner overflow container. The reset therefore targets the window; documentElement
// and body scrollTop are reset too for robustness across scroll roots.
//
// Forward navigations (Link clicks, router.push) land at the top. Browser Back/
// Forward (popstate) is left alone so Next's default scroll restoration keeps
// working — we only set the *initial* position on new-route navigations.

// useLayoutEffect on the client (reset before paint → no visible jump), useEffect on
// the server (avoids the SSR "useLayoutEffect does nothing on the server" warning).
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export default function ScrollToTop() {
  const pathname = usePathname();
  const isPopNavigation = useRef(false);

  useEffect(() => {
    // popstate fires synchronously for Back/Forward, before the pathname-change
    // layout effect runs — so we can flag it and skip the reset for those.
    const onPopState = () => { isPopNavigation.current = true; };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (isPopNavigation.current) {
      // Browser Back/Forward — let the browser/Next restore the prior position.
      isPopNavigation.current = false;
      return;
    }
    // Instant jump (no smooth-scroll) to the top of the document.
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [pathname]);

  return null;
}
