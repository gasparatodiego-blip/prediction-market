import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUser } from '@/lib/auth';

export async function GET() {
  const user = await getUser();
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [alerts, unreadCount] = await Promise.all([
    prisma.alert.findMany({
      where:   { userId: user.id },
      orderBy: { sentAt: 'desc' },
      take:    50,
    }),
    prisma.alert.count({ where: { userId: user.id, read: false } }),
  ]);

  return NextResponse.json({ alerts, unreadCount });
}

export async function PATCH(req: NextRequest) {
  const user = await getUser();
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const ids  = Array.isArray(body.ids) ? body.ids : [];

  if (ids.length > 0) {
    await prisma.alert.updateMany({
      where: { id: { in: ids }, userId: user.id },
      data:  { read: true },
    });
  } else {
    // Mark all as read
    await prisma.alert.updateMany({ where: { userId: user.id, read: false }, data: { read: true } });
  }

  return NextResponse.json({ ok: true });
}
