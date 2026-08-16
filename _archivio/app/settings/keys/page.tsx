import KeysClient from './KeysClient'

export const dynamic = 'force-dynamic'

/**
 * Admin venue-credential management page. Middleware guarantees an authenticated
 * admin session before this renders (and 404s the whole lane if no admin secret is
 * configured), so no per-page gate is needed here.
 */
export default function SettingsKeysPage() {
  return <KeysClient />
}
