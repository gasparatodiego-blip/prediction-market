import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { normalizeAlertPrefs, ALERT_CATEGORIES } from '@/lib/notification-prefs';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await prisma.user.findUnique({
    where:  { id: session.user.id },
    select: { alertPrefs: true, telegramChatId: true },
  });
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return NextResponse.json({
    ...normalizeAlertPrefs(user.alertPrefs),
    telegramLinked: !!user.telegramChatId,
  });
}

const categoryShape = Object.fromEntries(
  ALERT_CATEGORIES.map((c) => [c, z.boolean().optional()]),
) as Record<typeof ALERT_CATEGORIES[number], z.ZodOptional<z.ZodBoolean>>;

const schema = z.object({ ...categoryShape, emailDigest: z.boolean().optional() });

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });

  const existing = await prisma.user.findUnique({
    where:  { id: session.user.id },
    select: { alertPrefs: true },
  });
  const merged = { ...normalizeAlertPrefs(existing?.alertPrefs), ...parsed.data };

  await prisma.user.update({
    where: { id: session.user.id },
    data:  { alertPrefs: merged },
  });

  return NextResponse.json(merged);
}
