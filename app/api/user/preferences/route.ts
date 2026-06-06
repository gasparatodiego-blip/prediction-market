import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { getUser } from '@/lib/auth';

const schema = z.object({
  minRoi:        z.number().min(0).max(100).optional(),
  minConfidence: z.number().min(0).max(100).int().optional(),
  platforms:     z.array(z.string()).optional(),
  alertTypes:    z.array(z.string()).optional(),
  maxBankroll:   z.number().min(0).optional(),
  alertsEnabled: z.boolean().optional(),
  telegramChatId: z.string().optional(),
});

export async function GET() {
  const user = await getUser();
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const prefs = await prisma.userPreferences.findUnique({ where: { userId: user.id } });
  return NextResponse.json(prefs ?? {});
}

export async function POST(req: NextRequest) {
  const user = await getUser();
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body  = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });

  const { telegramChatId, ...prefsData } = parsed.data;

  const prefs = await prisma.userPreferences.upsert({
    where:  { userId: user.id },
    create: { userId: user.id, ...prefsData },
    update: prefsData,
  });

  if (telegramChatId !== undefined) {
    await prisma.user.update({ where: { id: user.id }, data: { telegramChatId } });
  }

  return NextResponse.json(prefs);
}
