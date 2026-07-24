import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { listRows, saveRow, type VenueId } from '@/lib/admin-venue-keys'
import { appendAudit } from '@/lib/key-custody-audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Admin venue-credential store (polymarket + kalshi). Middleware has already gated
 * this to an authenticated admin session.
 *
 * WHAT NEVER LEAVES THIS ROUTE: apiKey, apiSecret, passphrase. The only
 * credential-derived value returned is last4. The wallet address is public.
 */

const VENUES = [
  { id: 'polymarket' as const, label: 'Polymarket' },
  { id: 'kalshi' as const, label: 'Kalshi' },
]

const saveSchema = z.object({
  venue: z.enum(['polymarket', 'kalshi']),
  label: z.string().trim().min(1).max(64),
  walletAddress: z.string().trim().min(1).max(128).optional(), // PUBLIC identifier
  apiKey: z.string().trim().min(1).max(512).optional(),
  apiSecret: z.string().trim().min(1).max(4096), // Kalshi PEM is long
  passphrase: z.string().trim().min(1).max(512).optional(),
})

export async function GET() {
  const rows = await listRows()
  return NextResponse.json({ rows, venues: VENUES })
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Missing or invalid fields.' }, { status: 400 })
  }

  const parsed = saveSchema.safeParse(body)
  if (!parsed.success) {
    // Never name a value — a fixed message only.
    return NextResponse.json({ error: 'Missing or invalid fields.' }, { status: 400 })
  }
  const d = parsed.data
  const venue = d.venue as VenueId

  // Per-venue required credentials.
  if (venue === 'kalshi') {
    if (!d.apiKey || !d.apiSecret) {
      return NextResponse.json({ error: 'Missing or invalid fields.' }, { status: 400 })
    }
  } else {
    // polymarket
    if (!d.walletAddress || !d.apiKey || !d.apiSecret || !d.passphrase) {
      return NextResponse.json({ error: 'Missing or invalid fields.' }, { status: 400 })
    }
  }

  let row
  try {
    row = await saveRow({
      venue,
      label: d.label,
      walletAddress: d.walletAddress ?? null,
      apiKey: d.apiKey ?? null,
      apiSecret: d.apiSecret,
      passphrase: d.passphrase ?? null,
    })
  } catch {
    // saveRow rejects malformed input (e.g. a non-0x40 wallet address) — a fixed message, never a value.
    return NextResponse.json({ error: 'Missing or invalid fields.' }, { status: 400 })
  }

  await appendAudit({ venue, action: 'saved', outcome: 'stored', last4: row.last4 })

  // PUBLIC row only — never any secret.
  return NextResponse.json(
    {
      id: row.id,
      venue: row.venue,
      label: row.label,
      walletAddress: row.walletAddress,
      last4: row.last4,
      status: row.status,
      savedAt: row.savedAt,
    },
    { status: 201 },
  )
}
