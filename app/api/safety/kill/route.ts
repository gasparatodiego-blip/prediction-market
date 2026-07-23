import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
// The durable execution kill switch (venue-agnostic, fail-closed). CommonJS module.
import {
  killStatus, setGlobalKill, clearGlobalKill, setUserKill, clearUserKill,
} from '@/lib/safety/kill-switch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // must be Node (reads the durable file + uses fs), never edge

// ADMIN-ONLY. Tripping/clearing execution for real money is an operator action. The role is read from the
// DB row server-side in the auth callback (never the client token), so this cannot be spoofed by a
// crafted request. A non-admin (or anonymous) caller gets 401/403 and the state is untouched.
async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.user.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 }) };
  return { session };
}

// GET → current kill status (readable / global / per-user). Unreadable state reports effectivelyKilled.
export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  return NextResponse.json(killStatus());
}

const bodySchema = z.object({
  action: z.enum(['global-kill', 'global-clear', 'user-kill', 'user-clear']),
  userId: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().max(500).optional(),
});

// POST → set/clear a kill. Takes effect on the NEXT placement attempt (state is re-read at the chokepoint).
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'invalid body', detail: parsed.error.flatten() }, { status: 400 });

  const { action, userId, reason } = parsed.data;
  const by = `admin:${gate.session!.user.id}`;
  const meta = { reason: reason ?? null, by };

  if (action === 'global-kill') setGlobalKill(meta);
  else if (action === 'global-clear') clearGlobalKill(meta);
  else if (action === 'user-kill') {
    if (!userId) return NextResponse.json({ error: 'userId required for user-kill' }, { status: 400 });
    setUserKill({ userId, ...meta });
  } else if (action === 'user-clear') {
    if (!userId) return NextResponse.json({ error: 'userId required for user-clear' }, { status: 400 });
    clearUserKill({ userId, ...meta });
  }
  return NextResponse.json({ ok: true, action, userId: userId ?? null, status: killStatus() });
}
