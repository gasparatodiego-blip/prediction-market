import { NextRequest, NextResponse } from 'next/server'
import { adminSecretConfigured, mintAdminSession, ADMIN_COOKIE, TTL_SECONDS } from '@/lib/admin-session'
import { checkAdminSecret } from '@/lib/admin-secret'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// TTL_SECONDS is IMPORTED, not re-declared. It used to be a second literal here that merely happened to
// match the JWT's — two numbers, one meaning, and nothing to keep them in step. A cookie shorter than the
// token silently ends the session early; a cookie longer than it leaves the browser sending a token the
// server already rejects. Both look like "the login does not stick" and neither logs anything.

/**
 * Admin login for the file-backed venue-credential settings lane.
 *
 * NEVER echoes the submitted secret — not on success, not on failure, not in a log.
 * The failure response is a fixed string.
 */
export async function POST(req: NextRequest) {
  if (!adminSecretConfigured()) {
    return new NextResponse(null, { status: 404 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid access secret.' }, { status: 401 })
  }

  const secret = (body as { secret?: unknown })?.secret
  if (typeof secret !== 'string' || !checkAdminSecret(secret)) {
    return NextResponse.json({ error: 'Invalid access secret.' }, { status: 401 })
  }

  const token = await mintAdminSession()
  const res = NextResponse.json({ ok: true })
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: TTL_SECONDS,
  })
  return res
}

/** DELETE → logout: clear the admin cookie. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(ADMIN_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  })
  return res
}
