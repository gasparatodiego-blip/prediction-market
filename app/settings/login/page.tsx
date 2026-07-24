import { notFound } from 'next/navigation'
import { adminSecretConfigured } from '@/lib/admin-session'
import LoginClient from './LoginClient'

export const dynamic = 'force-dynamic'

/**
 * Admin login page for the file-backed venue-credential settings lane. Middleware
 * lets this path through without a session so the form is reachable; if no admin
 * secret is configured the whole feature is hidden (404).
 */
export default function SettingsLoginPage() {
  if (!adminSecretConfigured()) notFound()
  return <LoginClient />
}
