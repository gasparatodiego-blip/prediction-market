import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
// EDGE-SAFE import only: verifyAdminSession + ADMIN_COOKIE use jose (Web Crypto),
// never node `crypto`. The node-crypto secret compare lives in lib/admin-secret.ts,
// which is deliberately NOT imported here.
import { verifyAdminSession, ADMIN_COOKIE } from '@/lib/admin-session';

const cache = new Map<string, { count: number; reset: number }>();
const WINDOW_MS   = 60_000;
const MAX_PER_WIN = 100;

function getIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- Admin-gated settings lane (file-backed venue credentials) ------------
  // Everything under /settings and /api/settings is admin-only, and hidden
  // entirely (404) unless ADMIN_ACCESS_SECRET is configured. The login page and
  // the login POST are the only paths reachable without a valid session.
  //
  // The maker kill switch (/dashboard/maker page + /api/maker cancel API) rides the
  // SAME ADMIN_ACCESS_SECRET gate — it can cancel real orders, so it must never be
  // public. Only these two maker paths are gated; the rest of /dashboard stays public.
  // The ACTIVE bot universe is public read-only info shown on the public rewards board, so GET
  // /api/maker/universe is exempt from the admin gate. CHANGING it (POST) stays gated below.
  if (pathname === '/api/maker/universe' && request.method === 'GET') {
    return NextResponse.next();
  }
  const isSettingsLane = pathname.startsWith('/settings') || pathname.startsWith('/api/settings');
  const isMakerLane =
    pathname === '/dashboard/maker' ||
    pathname.startsWith('/dashboard/maker/') ||
    pathname.startsWith('/api/maker');
  if (isSettingsLane || isMakerLane) {
    const secret = process.env.ADMIN_ACCESS_SECRET;
    if (!secret || secret.length === 0) {
      // Feature hidden: no secret configured, no such surface.
      return new NextResponse(null, { status: 404 });
    }

    // The login form and the login POST must be reachable without a session.
    if (pathname === '/settings/login' || pathname === '/api/settings/login') {
      return NextResponse.next();
    }

    const token = request.cookies.get(ADMIN_COOKIE)?.value;
    const ok = await verifyAdminSession(token);
    if (!ok) {
      // API routes (settings OR maker) get a 401 JSON; pages redirect to the admin login.
      if (pathname.startsWith('/api/')) {
        return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const url = request.nextUrl.clone();
      url.pathname = '/settings/login';
      url.search = '';
      return NextResponse.redirect(url);
    }
    // Authenticated admin — fall through (settings pages skip the API rate-limiter).
  }

  // Dashboard pages are intentionally public — the product rule is "never a login
  // wall on the main dashboard." Premium monetary fields are paywalled by
  // field-level redaction inside each API route (getIsPaid → redactForTier), and
  // personal/account routes enforce their own server-side session check. No
  // access-gating happens here.

  // Only rate-limit API routes that hit the filesystem
  if (!pathname.startsWith('/api/')) return NextResponse.next();
  // /api/health is cheap, skip
  if (pathname === '/api/health') return NextResponse.next();

  const ip  = getIp(request);
  const key = `${ip}:${pathname}`;
  const now = Date.now();

  let entry = cache.get(key);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + WINDOW_MS };
    cache.set(key, entry);
  }

  entry.count++;

  if (entry.count > MAX_PER_WIN) {
    return new NextResponse('Too Many Requests', {
      status: 429,
      headers: {
        'Retry-After': String(Math.ceil((entry.reset - now) / 1000)),
        'X-RateLimit-Limit': String(MAX_PER_WIN),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset':    String(Math.ceil(entry.reset / 1000)),
      },
    });
  }

  return NextResponse.next({
    headers: {
      'X-RateLimit-Limit':     String(MAX_PER_WIN),
      'X-RateLimit-Remaining': String(MAX_PER_WIN - entry.count),
      'X-RateLimit-Reset':     String(Math.ceil(entry.reset / 1000)),
    },
  });
}

export const config = {
  // /api/:path* already covers /api/maker; add the maker dashboard page so the gate runs on it too.
  // The rest of /dashboard is deliberately absent here — it stays public.
  matcher: ['/settings/:path*', '/dashboard/maker', '/dashboard/maker/:path*', '/api/:path*'],
};
