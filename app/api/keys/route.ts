import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import prisma from '@/lib/prisma'
import { getVenue, canAcceptKeys, VENUES } from '@/lib/venues/registry'
import { decideStorage, VenueCreds } from '@/lib/venues/types'
import { newDek, wrapDek, unwrapDek, encryptField, decryptField } from '@/lib/key-custody'

export const dynamic = 'force-dynamic'

/**
 * Connect / list exchange API keys.
 *
 * WHAT NEVER LEAVES THIS ROUTE: the api key, the secret, the passphrase. Not
 * plaintext, not masked-from-plaintext, not "just the public part". The only
 * credential-derived value ever returned is `last4` of the api key, and it is
 * computed at WRITE time from the submitted value and stored nowhere — it is derived
 * on read by decrypting, never persisted alongside the ciphertext.
 *
 * A key is NEVER stored unless the venue told us plainly that it cannot withdraw.
 * See lib/venues/types.ts decideStorage() — the single choke point.
 */

const connectSchema = z.object({
  venue: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1).max(64),
  // apiKey is OPTIONAL: dYdX authenticates with a private key + non-secret
  // identifiers and has no api key. Per-venue requiredFields() enforces presence.
  apiKey: z.string().trim().min(1).max(256).optional(),
  secret: z.string().trim().min(1).max(256),
  passphrase: z.string().trim().min(1).max(256).optional(),
  // Non-secret identifiers (dYdX). Plaintext by design; validated per venue below.
  accountAddress: z.string().trim().min(1).max(128).optional(),
  accountId: z.string().trim().min(1).max(64).optional(),
  subaccountNumber: z.number().int().min(0).max(2_000_000_000).optional(),
})

function last4(s: string): string {
  return s.length <= 4 ? s : s.slice(-4)
}

/**
 * Derive the api key's last 4 by decrypting, per read. The plaintext exists only
 * inside this function and is zeroed-adjacent by scope; it is never returned, logged,
 * or persisted. If a row cannot be decrypted (e.g. its KEK version is not held), we
 * return null rather than guessing — an undecryptable row is a real condition, not a
 * blank.
 */
function deriveLast4(r: { apiKeyEnc: string | null; dekEnc: string; kekVersion: number }): string | null {
  if (!r.apiKeyEnc) return null // venues with no api key (dYdX) have no last4
  try {
    const dek = unwrapDek(r.dekEnc, r.kekVersion)
    try {
      return last4(decryptField(r.apiKeyEnc, dek))
    } finally {
      dek.fill(0)
    }
  } catch {
    return null
  }
}

/** GET → the caller's own keys. Never a key, a secret, or a passphrase. */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = session.user.id

  const rows = await prisma.exchangeKey.findMany({
    where: { userId }, // ownership: the caller's own rows, always
    orderBy: { createdAt: 'desc' },
    // Explicit select. NOT a bare findMany — apiSecretEnc/passphraseEnc must never
    // ride along into a response by accident. apiKeyEnc + dekEnc are selected ONLY to
    // derive last4 below, and neither leaves this function.
    select: {
      id: true,
      venue: true,
      label: true,
      permissionsAtVerify: true,
      verifiedAt: true,
      createdAt: true,
      revokedAt: true,
      apiKeyEnc: true,
      dekEnc: true,
      kekVersion: true,
      // Non-secret identifiers — safe to return (a public address, an id).
      accountAddress: true,
      accountId: true,
      subaccountNumber: true,
    },
  })

  return NextResponse.json({
    keys: rows.map((r) => ({
      id: r.id,
      venue: r.venue,
      label: r.label,
      // Named to match reality: what the venue said when we checked, and when.
      permissionsAtVerify: r.permissionsAtVerify,
      verifiedAt: r.verifiedAt,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
      // Derived per read by decrypting, NEVER stored as a plaintext column. Four
      // characters of an api key is still a fragment of a secret, and this codebase's
      // rule is that nothing is stored in plaintext — not even "just the public part".
      last4: deriveLast4(r),
      // Non-secret identifiers ARE returned — they are public, not credentials.
      accountAddress: r.accountAddress,
      accountId: r.accountId,
      subaccountNumber: r.subaccountNumber,
    })),
    venues: VENUES.map((v) => ({
      id: v.adapter.id,
      label: v.adapter.label,
      requiredFields: v.adapter.requiredFields(),
      requiredPlainFields: v.adapter.requiredPlainFields ? v.adapter.requiredPlainFields() : [],
      guardVerifiable: v.guardVerifiable,
      liveVerified: v.liveVerified,
      mainnetOnly: v.mainnetOnly,
      note: v.note,
    })),
  })
}

/** POST → verify against the real venue, then store. Never stores an unverified key. */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = session.user.id

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const parsed = connectSchema.safeParse(body)
  if (!parsed.success) {
    // zod's message names fields, never values — but be explicit rather than trusting that.
    return NextResponse.json({ error: 'Missing or invalid fields.' }, { status: 400 })
  }
  const d = parsed.data

  const reg = getVenue(d.venue)
  if (!reg) {
    return NextResponse.json({ error: `Unknown venue: ${d.venue}` }, { status: 400 })
  }

  // A venue whose guard can never be verified is refused permanently, with a
  // different message than one merely awaiting verification. Do not merge these.
  if (!reg.guardVerifiable) {
    return NextResponse.json({ error: reg.note, code: 'VENUE_UNSUPPORTED' }, { status: 409 })
  }

  if (!canAcceptKeys(reg)) {
    return NextResponse.json(
      {
        error: 'Adapter not yet verified against the live venue.',
        code: 'ADAPTER_NOT_LIVE_VERIFIED',
        detail: reg.note,
      },
      { status: 409 },
    )
  }

  // requiredFields drives validation, so OKX's passphrase is enforced without
  // Binance being forced to invent one, and dYdX is not forced to invent an api key.
  const required = reg.adapter.requiredFields()
  const missing = required.filter((f) => !d[f])
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `${reg.adapter.label} requires: ${missing.join(', ')}.` },
      { status: 400 },
    )
  }

  // Non-secret identifiers (dYdX) enforced the same way, from a separate list.
  const requiredPlain = reg.adapter.requiredPlainFields ? reg.adapter.requiredPlainFields() : []
  const missingPlain = requiredPlain.filter(
    (f) => f !== 'subaccountNumber' && (d[f] === undefined || d[f] === null || d[f] === ''),
  )
  if (missingPlain.length > 0) {
    return NextResponse.json(
      { error: `${reg.adapter.label} requires: ${missingPlain.join(', ')}.` },
      { status: 400 },
    )
  }

  const creds: VenueCreds = {
    apiKey: d.apiKey,
    secret: d.secret,
    passphrase: d.passphrase ?? null,
    accountAddress: d.accountAddress ?? null,
    accountId: d.accountId ?? null,
    subaccountNumber: d.subaccountNumber ?? null,
  }

  // Verify against the REAL venue before anything touches the database.
  const verdict = await reg.adapter.verifyKey(creds)
  const decision = decideStorage(verdict)

  if (!decision.store) {
    // Nothing was written. The reason is from a fixed vocabulary and never contains
    // the credential, a signature, or a raw exception.
    return NextResponse.json(
      { error: decision.reason, canWithdraw: verdict.canWithdraw },
      { status: 400 },
    )
  }

  // Only now, having been told plainly the key cannot withdraw, do we store it.
  const dek = newDek()
  try {
    const created = await prisma.exchangeKey.create({
      data: {
        userId,
        venue: reg.adapter.id,
        label: d.label,
        // Null for venues with no api key (dYdX). Never encrypt an empty string.
        apiKeyEnc: d.apiKey ? encryptField(d.apiKey, dek) : null,
        apiSecretEnc: encryptField(d.secret, dek),
        passphraseEnc: d.passphrase ? encryptField(d.passphrase, dek) : null,
        // Non-secret identifiers, stored PLAINTEXT by design.
        accountAddress: d.accountAddress ?? null,
        accountId: d.accountId ?? null,
        subaccountNumber: d.subaccountNumber ?? null,
        dekEnc: wrapDek(dek, 1),
        kekVersion: 1,
        permissionsAtVerify: verdict.permissions,
        verifiedAt: new Date(),
      },
      select: { id: true, venue: true, label: true, permissionsAtVerify: true, verifiedAt: true },
    })

    return NextResponse.json(
      {
        id: created.id,
        venue: created.venue,
        label: created.label,
        permissionsAtVerify: created.permissionsAtVerify,
        verifiedAt: created.verifiedAt,
        last4: d.apiKey ? last4(d.apiKey) : null,
      },
      { status: 201 },
    )
  } finally {
    dek.fill(0)
  }
}
