import { NextRequest, NextResponse } from 'next/server';
import { ensureAdmin, getUserByEmail, verifyPassword, signToken } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    ensureAdmin();
    const { email, password } = await request.json();
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }
    const user = getUserByEmail(email);
    if (!user) return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });

    const valid = await verifyPassword(password, user.password);
    if (!valid) return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });

    const token = await signToken({ id: user.id, email: user.email, role: user.role, created_at: user.created_at });

    const res = NextResponse.json({ user: { id: user.id, email: user.email, role: user.role } });
    res.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: false,  // no HTTPS proxy on this server — must be false for HTTP
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    });
    return res;
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
