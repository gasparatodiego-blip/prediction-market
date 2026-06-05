import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, getAllUsers, setUserRole, type UserRole } from '@/lib/auth';

async function requireAdmin(request: NextRequest) {
  const token = request.cookies.get('auth_token')?.value;
  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload || payload.role !== 'admin') return null;
  return payload;
}

export async function GET(request: NextRequest) {
  if (!await requireAdmin(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return NextResponse.json({ users: getAllUsers() });
}

export async function PATCH(request: NextRequest) {
  if (!await requireAdmin(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { id, role } = await request.json();
  if (!id || !['free', 'pro', 'admin'].includes(role)) {
    return NextResponse.json({ error: 'Invalid id or role' }, { status: 400 });
  }
  setUserRole(id, role as UserRole);
  return NextResponse.json({ ok: true });
}
