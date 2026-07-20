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
    return [
      // /dashboard/crypto used to land on the Funding tab; that tab is now retired, so
      // send it straight to Overview rather than through a two-hop redirect chain.
      { source: '/dashboard/crypto',        destination: '/dashboard',             permanent: true },
      { source: '/dashboard/opportunities', destination: '/dashboard',             permanent: true },
      { source: '/dashboard/lp',            destination: '/dashboard',             permanent: true },
      { source: '/dashboard/mm',            destination: '/dashboard',             permanent: true },

      // Retired tabs (UI only — agents, /api/crypto and /api/sports-snapshot untouched).
      // A config-level redirect supersedes the page without deleting it, which is the
      // pattern already used above for lp/mm, so restoring a tab is just deleting its
      // line here plus the nav entry.
      { source: '/dashboard/sports',           destination: '/dashboard/sport-arb', permanent: true },
      { source: '/dashboard/funding-arb',      destination: '/dashboard',           permanent: true },
      { source: '/dashboard/funding-arb/:id',  destination: '/dashboard',           permanent: true },
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
