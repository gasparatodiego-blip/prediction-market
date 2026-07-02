import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

const cache = new Map<string, { count: number; reset: number }>();
const WINDOW_MS   = 60_000;
const MAX_PER_WIN = 100;

function getIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith('/dashboard')) {
    const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    if (!token) {
      const loginUrl = new URL('/auth/login', request.url);
      loginUrl.searchParams.set('callbackUrl', pathname + request.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

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
  matcher: ['/api/:path*', '/dashboard/:path*'],
};
