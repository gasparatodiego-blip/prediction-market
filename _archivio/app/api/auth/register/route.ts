import { NextRequest, NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import prisma from '@/lib/prisma';

const schema = z.object({
  email:    z.string().email(),
  password: z.string().min(8),
  name:     z.string().min(1).max(100).optional(),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 });

  const { email, password, name } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: 'Email already registered' }, { status: 409 });

  const passwordHash = await hash(password, 12);
  const user = await prisma.user.create({ data: { email, passwordHash, name } });
  await prisma.userPreferences.create({ data: { userId: user.id } });
  await prisma.portfolio.create({ data: { userId: user.id } });

  return NextResponse.json({ ok: true, userId: user.id }, { status: 201 });
}
