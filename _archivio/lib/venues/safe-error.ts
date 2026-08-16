/**
 * Map any thrown error to a short, user-safe string.
 *
 * This NEVER passes a raw exception through. A signed request carries credentials
 * in places an exception can pick up: Binance puts `signature=` in the query string,
 * and lib/httpGet builds messages containing `url.slice(0, 80)`. lib/rateLimitedFetch
 * already redacts query strings on signed calls; this is the second layer, and the
 * one that guarantees a user-facing string is built from a fixed vocabulary rather
 * than from anything the network handed us.
 *
 * Categories only. If you want the raw error for debugging, do not add it here —
 * it is exactly the thing that must not travel.
 */
export function toSafeError(e: unknown): string {
  const msg = String((e as { message?: string })?.message ?? e ?? '')

  if (/wall-clock timeout/i.test(msg)) {
    return 'The venue did not respond in time. Nothing was stored.'
  }
  if (/\b429\b|rate.?limit|in backoff/i.test(msg)) {
    return 'The venue rate-limited this request. Nothing was stored. Please try again shortly.'
  }
  if (/bad JSON/i.test(msg)) {
    return 'The venue returned a response we could not read. Nothing was stored.'
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|network/i.test(msg)) {
    return 'Could not reach the venue. Nothing was stored.'
  }
  return 'Could not verify this key against the venue. Nothing was stored.'
}
