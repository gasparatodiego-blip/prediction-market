import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { compare, hash } from 'bcryptjs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';

const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8),
  confirmPassword: z.string().min(1),
}).refine((d) => d.newPassword === d.confirmPassword, {
  message: 'New password and confirmation do not match',
  path:    ['confirmPassword'],
});

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body   = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where:  { id: session.user.id },
    select: { passwordHash: true },
  });
  if (!user?.passwordHash) {
    // Google-only accounts have no password to change against.
    return NextResponse.json({ error: 'No password set on this account' }, { status: 400 });
  }

  const valid = await compare(parsed.data.currentPassword, user.passwordHash);
  if (!valid) return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 });

  const passwordHash = await hash(parsed.data.newPassword, 12);
  await prisma.user.update({
    where: { id: session.user.id },
    data:  { passwordHash },
  });

  return NextResponse.json({ ok: true });
}
