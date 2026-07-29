import { NextRequest, NextResponse } from 'next/server'
import { adminSecretConfigured, mintAdminSession, ADMIN_COOKIE } from '@/lib/admin-session'
import { checkAdminSecret } from '@/lib/admin-secret'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TTL_SECONDS = 12 * 60 * 60 // 12h — matches the JWT expiry

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
