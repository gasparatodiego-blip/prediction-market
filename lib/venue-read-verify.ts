import { createSign, createHmac, constants } from 'crypto'
import type { VenueId, DecryptedCreds } from '@/lib/admin-venue-keys'

/**
 * Two-stage verification: a REAL authenticated, read-only HTTP GET to a harmless
 * endpoint at the venue. Status may flip to VERIFIED only on a genuine HTTP 200 —
 * NEVER fabricated. This makes no order and touches no maker.
 *
 * HONEST-ENGINE / SECURITY: the api secret, the passphrase, and the wallet address
 * are used only to sign the request. They are never logged, never returned, and
 * never placed in an error or detail string.
 */

export interface VerifyResult {
  ok: boolean
  error: string | null
  detail: string | null
}

const TIMEOUT_MS = 12_000

/**
 * Trim a venue error body to a short, credential-free snippet.
 *
 * The operator has to be able to READ the venue's error — that is the whole point of
 * showing it. A blanket ">=20 token-ish chars" rule censored real messages: '/' counts
 * as a token char, so Polymarket's "Unauthorized/Invalid api key" (that run is exactly
 * 20 chars) surfaced as "[redacted] api key" and hid the actual cause. Two bands
 * instead, both of which still cover every credential shape we hold:
 *
 *   >= 32 chars            → always redacted. Our credentials are all longer than this
 *                            (Polymarket apiKey 36 / secret 44 / passphrase 64; a Kalshi
 *                            key id is a 36-char UUID), so this band is the real guard.
 *   20-31 chars with digit → redacted. Opaque-token shaped; readable error prose in this
 *                            length band ("Unauthorized/Invalid", "INSUFFICIENT_BALANCE")
 *                            has no digits, so it survives.
 *
 * This is the VENUE's response, not ours — no credential is placed in it by this module.
 * The redaction is defence in depth, so it errs long rather than clever.
 */
function safeSnippet(body: string): string | null {
  if (!body) return null
  const stripped = body
    .replace(/[A-Za-z0-9_\-+/=]{20,}/g, (run) =>
      run.length >= 32 || /\d/.test(run) ? '[redacted]' : run,
    )
    .trim()
  if (!stripped) return null
  return stripped.slice(0, 200)
}

async function timedFetch(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { method: 'GET', headers, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

async function verifyKalshi(creds: DecryptedCreds): Promise<VerifyResult> {
  const apiKey = creds.apiKey
  const pem = creds.apiSecret // RSA private key (PEM)
  if (!apiKey || !pem) {
    return { ok: false, error: 'Kalshi requires an API key ID and an RSA private key.', detail: null }
  }

  const method = 'GET'
  const routePath = '/trade-api/v2/portfolio/balance'
  const timestamp = Date.now().toString()
  const message = `${timestamp}${method}${routePath}`

  let signature: string
  try {
    const signer = createSign('sha256')
    signer.update(message)
    signer.end()
    signature = signer.sign(
      {
        key: pem,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      },
      'base64',
    )
  } catch (e) {
    // A bad PEM or an unsupported key throws here — surface the exact message,
    // which is about the key FORMAT, never the key material.
    return { ok: false, error: (e as Error).message, detail: null }
  }

  try {
    const res = await timedFetch(
      `https://api.elections.kalshi.com${routePath}`,
      {
        'KALSHI-ACCESS-KEY': apiKey,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
        'Content-Type': 'application/json',
      },
    )
    if (res.status === 200) return { ok: true, error: null, detail: null }
    const body = await res.text().catch(() => '')
    return { ok: false, error: `HTTP ${res.status}`, detail: safeSnippet(body) }
  } catch (e) {
    return { ok: false, error: (e as Error).message, detail: null }
  }
}

async function verifyPolymarket(creds: DecryptedCreds): Promise<VerifyResult> {
  const address = creds.walletAddress
  const apiKey = creds.apiKey
  const secret = creds.apiSecret
  const passphrase = creds.passphrase
  if (!address || !apiKey || !secret || !passphrase) {
    return {
      ok: false,
      error: 'Polymarket requires a wallet address, API key, secret, and passphrase.',
      detail: null,
    }
  }

  const method = 'GET'
  const routePath = '/auth/api-keys'
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const message = `${timestamp}${method}${routePath}`

  let signature: string
  try {
    // Polymarket L2: HMAC-SHA256 over the message using the base64-decoded secret,
    // emitted as URL-SAFE base64 that KEEPS the '=' padding.
    //
    // Node's digest('base64url') is NOT the same thing: it strips the padding, so a
    // 32-byte HMAC comes out 43 chars instead of 44 and the CLOB rejects the request
    // with 401 "Unauthorized/Invalid api key". The venue wants exactly what the
    // official SDK's buildPolyHmacSignature emits — standard base64, then '+'→'-'
    // and '/'→'_', padding left intact
    // (node_modules/@polymarket/clob-client/dist/signing/hmac.js).
    const key = Buffer.from(secret, 'base64url') // decodes base64 and base64url alike
    signature = createHmac('sha256', key)
      .update(message)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
  } catch (e) {
    return { ok: false, error: (e as Error).message, detail: null }
  }

  try {
    const res = await timedFetch(`https://clob.polymarket.com${routePath}`, {
      POLY_ADDRESS: address,
      POLY_API_KEY: apiKey,
      POLY_PASSPHRASE: passphrase,
      POLY_TIMESTAMP: timestamp,
      POLY_SIGNATURE: signature,
    })
    if (res.status === 200) return { ok: true, error: null, detail: null }
    const body = await res.text().catch(() => '')
    return { ok: false, error: `HTTP ${res.status}`, detail: safeSnippet(body) }
  } catch (e) {
    return { ok: false, error: (e as Error).message, detail: null }
  }
}

export async function verifyRead(venue: VenueId, creds: DecryptedCreds): Promise<VerifyResult> {
  if (venue === 'kalshi') return verifyKalshi(creds)
  if (venue === 'polymarket') return verifyPolymarket(creds)
  return { ok: false, error: `Unsupported venue: ${venue}`, detail: null }
}
