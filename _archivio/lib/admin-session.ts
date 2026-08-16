import { SignJWT, jwtVerify } from 'jose'

/**
 * Admin session tokens for the file-backed, admin-gated venue-credential settings
 * lane. This is a SEPARATE system from the per-user next-auth CEX custody — there
 * is no userId here, just a single shared operator secret held in
 * ADMIN_ACCESS_SECRET.
 *
 * EDGE-SAFE ON PURPOSE. This module imports ONLY jose (Web Crypto under the hood)
 * and TextEncoder. It never imports node `crypto`. middleware.ts runs on the edge
 * runtime and imports `verifyAdminSession` + `ADMIN_COOKIE` from here, so nothing
 * reachable from those two may pull in node crypto. The timing-safe secret compare
 * that DOES need node crypto lives in lib/admin-secret.ts, which middleware never
 * imports.
 */

export const ADMIN_COOKIE = 'edgeradar_admin'

const ISSUER = 'edgeradar'
const AUDIENCE = 'edgeradar-admin'

/**
 * HOW LONG AN ADMIN SESSION LASTS — 90 days. EXPORTED because it governs TWO things that must agree:
 * the JWT's own `exp` claim (minted below) and the browser cookie's `maxAge` (set in
 * app/api/settings/login/route.ts). Those used to be two separate literals that merely happened to
 * match; they are one value now, because the failure mode of drift is silent and confusing — a 90-day
 * token inside a cookie the browser discards after 12 hours looks exactly like "the login does not
 * stick", with nothing in any log to say why.
 *
 * WHY 90 DAYS AND NOT LONGER. Was 12h, which meant re-logging in most days: the console then silently
 * falls back to the PUBLIC rewards board (LiquidityRewardsConsole renders <RewardsUnified/> on a 401),
 * so an expired session does not look like an expired session — it looks like the operator console
 * disappeared. 90 days removes that as routine friction while keeping a real ceiling: a leaked cookie
 * stops working by itself eventually, and there is a natural moment to re-assert control. A token with
 * no expiry has neither property.
 *
 * REVOCATION, so it is not assumed. There is no session store and no per-session id — every token is
 * just an HS256 signature over ADMIN_ACCESS_SECRET. So the ONLY way to invalidate outstanding sessions
 * before they lapse is to CHANGE ADMIN_ACCESS_SECRET (which invalidates all of them at once, including
 * your own). That was equally true at 12h; a 90-day window simply means the "wait for it to expire"
 * option now takes up to 90 days instead of half a day.
 */
export const TTL_SECONDS = 90 * 24 * 60 * 60 // 90 days

/** True iff a usable admin secret is configured. The feature is hidden entirely otherwise. */
export function adminSecretConfigured(): boolean {
  const s = process.env.ADMIN_ACCESS_SECRET
  return typeof s === 'string' && s.length > 0
}

function secretKey(): Uint8Array {
  const s = process.env.ADMIN_ACCESS_SECRET
  if (!s || s.length === 0) {
    // Callers should have checked adminSecretConfigured() first; mint/verify must
    // never silently succeed with an empty key.
    throw new Error('ADMIN_ACCESS_SECRET is not set')
  }
  return new TextEncoder().encode(s)
}

/** Mint an admin session JWT (HS256), valid for TTL_SECONDS. NO SLIDING RENEWAL: this is the only
 *  place a token is minted, and the middleware verifies without re-issuing, so the expiry is absolute
 *  from the moment of login rather than extended by use. */
export async function mintAdminSession(): Promise<string> {
  return new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secretKey())
}

/** Verify an admin session token. False on any error, missing token, or bad claims. */
export async function verifyAdminSession(token: string | undefined): Promise<boolean> {
  if (!token) return false
  if (!adminSecretConfigured()) return false
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    return payload.role === 'admin'
  } catch {
    return false
  }
}
