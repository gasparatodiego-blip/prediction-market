/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://api.telegram.org",
    ].join('; '),
  },
];

const nextConfig = {
  async redirects() {
    // Dashboard trimmed to the Liquidity-Rewards product: every non-rewards tab
    // redirects to /dashboard/liquidity-rewards. UI/routing only — agents, all API
    // routes (/api/crypto, /api/sports-snapshot, etc.) and the page sources are
    // untouched, so restoring a tab is deleting its line here plus its nav entry.
    // /dashboard/maker is intentionally absent: it is admin-gated in middleware and
    // must stay reachable, never redirected away.
    const REWARDS = '/dashboard/liquidity-rewards';
    return [
      // Root dashboard lands straight on Rewards (Overview hub kept but superseded).
      { source: '/dashboard',               destination: REWARDS, permanent: true },

      // Retired strategy tabs.
      { source: '/dashboard/prediction',    destination: REWARDS, permanent: true },
      { source: '/dashboard/carry',         destination: REWARDS, permanent: true },
      { source: '/dashboard/sport-arb',     destination: REWARDS, permanent: true },
      { source: '/dashboard/traders',       destination: REWARDS, permanent: true },
      { source: '/dashboard/portfolio',     destination: REWARDS, permanent: true },
      { source: '/dashboard/paper',         destination: REWARDS, permanent: true },
      { source: '/dashboard/copy',          destination: REWARDS, permanent: true },
      { source: '/dashboard/cex',           destination: REWARDS, permanent: true },
      { source: '/dashboard/hft',           destination: REWARDS, permanent: true },
      { source: '/dashboard/whales',        destination: REWARDS, permanent: true },

      // Previously-archived lanes — realigned to Rewards so every old link lands there.
      { source: '/dashboard/crypto',        destination: REWARDS, permanent: true },
      { source: '/dashboard/opportunities', destination: REWARDS, permanent: true },
      { source: '/dashboard/lp',            destination: REWARDS, permanent: true },
      { source: '/dashboard/mm',            destination: REWARDS, permanent: true },
      { source: '/dashboard/sports',        destination: REWARDS, permanent: true },
      { source: '/dashboard/funding-arb',      destination: REWARDS, permanent: true },
      { source: '/dashboard/funding-arb/:id',  destination: REWARDS, permanent: true },
    ];
  },
  async headers() {
    return [
      { source: '/(.*)', headers: securityHeaders },
      {
        source: '/_next/static/(.*)',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/api/markets',
        headers: [{ key: 'Cache-Control', value: 'public, s-maxage=30, stale-while-revalidate=60' }],
      },
      // Prevent browsers from caching HTML pages — stale HTML + fresh bundles = stale Server Action IDs
      {
        source: '/((?!_next/static|_next/image|favicon).*)',
        headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate' }],
      },
    ];
  },
  compress: true,
  poweredByHeader: false,
  images: { formats: ['image/webp', 'image/avif'] },
};

export default nextConfig;
