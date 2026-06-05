import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'pm-arb-secret-key-change-in-prod-2024x'
);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get('auth_token')?.value;

  // Admin routes: require admin role
  if (pathname.startsWith('/admin')) {
    if (!token) return NextResponse.redirect(new URL('/login', request.url));
    try {
      const { payload } = await jwtVerify(token, JWT_SECRET);
      if ((payload as any).role !== 'admin') {
        return NextResponse.redirect(new URL('/', request.url));
      }
      return NextResponse.next();
    } catch {
      const res = NextResponse.redirect(new URL('/login', request.url));
      res.cookies.delete('auth_token');
      return res;
    }
  }

  // Main dashboard: require any valid login
  if (!token) return NextResponse.redirect(new URL('/login', request.url));
  try {
    await jwtVerify(token, JWT_SECRET);
    return NextResponse.next();
  } catch {
    const res = NextResponse.redirect(new URL('/login', request.url));
    res.cookies.delete('auth_token');
    return res;
  }
}

export const config = {
  matcher: ['/', '/admin', '/admin/:path*'],
};
