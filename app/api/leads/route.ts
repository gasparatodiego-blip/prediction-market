import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function notifyTelegram(email: string, source: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id: chatId,
      text:    `🎯 New lead: ${email} (from ${source})`,
    }),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const email:  unknown = body?.email;
    const source: unknown = body?.source;

    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      return NextResponse.json({ ok: false, error: 'Invalid email address' }, { status: 400 });
    }
    if (typeof source !== 'string' || source.trim().length === 0) {
      return NextResponse.json({ ok: false, error: 'Missing source' }, { status: 400 });
    }

    const cleanEmail  = email.trim().toLowerCase();
    const cleanSource = source.trim();

    await prisma.lead.upsert({
      where:  { email: cleanEmail },
      create: { email: cleanEmail, source: cleanSource },
      update: { source: cleanSource },
    });

    // Telegram notification — failure never breaks the lead save
    try {
      await notifyTelegram(cleanEmail, cleanSource);
    } catch {
      // intentionally swallowed
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/leads]', err);
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 });
  }
}
