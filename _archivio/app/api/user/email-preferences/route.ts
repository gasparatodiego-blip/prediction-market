import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { getUser } from '@/lib/auth';

const schema = z.object({
  emailAlerts: z.boolean().optional(),
});

export async function GET() {
  const user = await getUser();
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const prefs = await prisma.userPreferences.findUnique({ where: { userId: user.id } });
  return NextResponse.json({ emailAlerts: prefs?.emailAlerts ?? false });
}

export async function POST(req: NextRequest) {
  const user = await getUser();
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });

  await prisma.userPreferences.upsert({
    where:  { userId: user.id },
    create: { userId: user.id, ...parsed.data },
    update: parsed.data,
  });

  return NextResponse.json({ ok: true });
}
