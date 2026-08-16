import { timingSafeEqual } from 'crypto'

/**
 * Timing-safe check of a candidate access secret against ADMIN_ACCESS_SECRET.
 *
 * NODE CRYPTO. Kept in its own module, SEPARATE from lib/admin-session.ts, so the
 * edge-runtime middleware — which imports only jose-based helpers — never pulls a
 * node `crypto` import into its bundle. This file is imported only by node-runtime
 * API routes.
 *
 * Guards the length mismatch before timingSafeEqual (which throws on unequal-length
 * buffers), and returns false rather than leaking which half was wrong.
 */
export function checkAdminSecret(candidate: string): boolean {
  const expected = process.env.ADMIN_ACCESS_SECRET
  if (typeof expected !== 'string' || expected.length === 0) return false
  if (typeof candidate !== 'string' || candidate.length === 0) return false

  const a = Buffer.from(candidate, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  // timingSafeEqual throws if the buffers differ in length; a length mismatch is
  // already a definite non-match, so short-circuit it here.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
