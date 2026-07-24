'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

const inputClass =
  'w-full px-3 rounded-button bg-surface border border-line text-ink font-body text-sm min-h-[44px] focus:outline-none focus:border-mint/60 placeholder:text-muted'

export default function LoginClient() {
  const router = useRouter()
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await fetch('/api/settings/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        // Show the exact error text the API returned (never the secret).
        setError(d.error || 'Invalid access secret.')
        return
      }
      setSecret('')
      router.push('/settings/keys')
    } catch {
      setError('Invalid access secret.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-card border border-line bg-surface p-6 space-y-5 shadow-card">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Admin access</h1>
          <p className="font-body text-sm text-muted mt-1">
            Enter the operator access secret to manage venue credentials.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4" autoComplete="off">
          <input
            className={inputClass}
            type="password"
            name="admin-access-secret"
            autoComplete="off"
            placeholder="Access secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            aria-label="Admin access secret"
          />
          {error && <p className="font-body text-sm text-coral-ink">{error}</p>}
          <button
            type="submit"
            disabled={busy || secret.length === 0}
            className="w-full min-h-[44px] rounded-button bg-mint text-white font-body text-sm font-semibold disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
