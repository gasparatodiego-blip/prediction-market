import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, getUserById } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const token = request.cookies.get('auth_token')?.value;
  if (!token) return NextResponse.json({ user: null }, { status: 401 });

  const payload = await verifyToken(token);
  if (!payload) return NextResponse.json({ user: null }, { status: 401 });

  const user = getUserById(parseInt(payload.sub));
  if (!user) return NextResponse.json({ user: null }, { status: 401 });

  return NextResponse.json({ user: { id: user.id, email: user.email, role: user.role } });
}
