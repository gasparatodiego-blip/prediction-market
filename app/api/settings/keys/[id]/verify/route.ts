import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  getDecryptedCreds,
  getStatus,
  getLast4,
  setStatus,
} from '@/lib/admin-venue-keys'
import { verifyRead } from '@/lib/venue-read-verify'
import { appendAudit } from '@/lib/key-custody-audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Two-stage verification for a stored credential. Middleware has already gated this
 * to an admin session.
 *
 *   action 'read'           — a harmless authenticated read against the real venue.
 *                             Status flips to VERIFIED_READ_ONLY ONLY on a genuine
 *                             HTTP 200. Never fabricated.
 *   action 'enable-trading' — a SEPARATE explicit step, allowed only once the key is
 *                             already VERIFIED_READ_ONLY. It records the operator's
 *                             intent and NOTHING more: it does NOT arm any maker, does
 *                             NOT place any order, and does NOT touch MAKER_MODE.
 *
 * NEVER returns plaintext credentials.
 */

const bodySchema = z.object({ action: z.enum(['read', 'enable-trading']) })

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const id = params?.id
  if (!id) return NextResponse.json({ error: 'Missing key id.' }, { status: 400 })

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'Missing or invalid fields.' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Missing or invalid fields.' }, { status: 400 })
  }
  const { action } = parsed.data

  const last4 = await getLast4(id)

  if (action === 'read') {
    const creds = await getDecryptedCreds(id)
    if (!creds) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 })
    }

    const result = await verifyRead(creds.venue, creds)

    if (result.ok) {
      const now = new Date().toISOString()
      await setStatus(id, 'VERIFIED_READ_ONLY', { verifiedAt: now, error: null })
      await appendAudit({ venue: creds.venue, action: 'verified', outcome: 'success', last4 })
      return NextResponse.json({ ok: true, status: 'VERIFIED_READ_ONLY' })
    }

    // Failure: keep the prior status, record lastError (never a credential).
    const prior = (await getStatus(id)) ?? 'NOT_CONNECTED'
    await setStatus(id, prior, { error: result.error })
    await appendAudit({ venue: creds.venue, action: 'verified', outcome: 'failure', last4 })
    return NextResponse.json(
      { ok: false, error: result.error, detail: result.detail },
      { status: 400 },
    )
  }

  // action === 'enable-trading'
  const current = await getStatus(id)
  if (current === null) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }
  if (current !== 'VERIFIED_READ_ONLY') {
    // Must pass the read-only test first — no shortcut to a trading status.
    return NextResponse.json({ error: 'Run Test read-only first.' }, { status: 400 })
  }

  const now = new Date().toISOString()
  // Records operator intent ONLY. This does NOT arm any maker, place any order, or
  // touch MAKER_MODE — there is no such flag in this system.
  const row = await setStatus(id, 'VERIFIED_TRADING', { tradingEnabledAt: now })
  await appendAudit({
    venue: row?.venue ?? 'unknown',
    action: 'trading-enabled',
    outcome: 'success',
    last4,
  })
  return NextResponse.json({ ok: true, status: 'VERIFIED_TRADING' })
}
