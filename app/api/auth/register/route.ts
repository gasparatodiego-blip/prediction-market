import { NextRequest, NextResponse } from 'next/server';
import { ensureAdmin, getUserByEmail, hashPassword, createUser, signToken } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    ensureAdmin();
    const { email, password } = await request.json();
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }
    const existing = getUserByEmail(email);
    if (existing) return NextResponse.json({ error: 'Email already registered' }, { status: 409 });

    const hash = await hashPassword(password);
    const user = createUser(email.toLowerCase(), hash);
    const token = await signToken(user);

    const res = NextResponse.json({ user: { id: user.id, email: user.email, role: user.role } });
    res.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    });
    return res;
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
