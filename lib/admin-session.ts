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
const TTL_SECONDS = 12 * 60 * 60 // 12h

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

/** Mint a 12h admin session JWT (HS256). */
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
