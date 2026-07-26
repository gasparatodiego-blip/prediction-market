'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

// UI tokens lifted from app/dashboard/settings/keys/KeysClient.tsx — restyles nothing.
const inputClass =
  'w-full px-3 rounded-button bg-surface border border-line text-ink font-body text-sm min-h-[44px] focus:outline-none focus:border-mint/60 placeholder:text-muted'
const cardClass = 'rounded-card border border-line bg-surface p-5 space-y-4 shadow-card'

type VenueId = 'polymarket' | 'kalshi'
type KeyStatus = 'NOT_CONNECTED' | 'VERIFIED_READ_ONLY' | 'VERIFIED_TRADING'

interface Venue {
  id: VenueId
  label: string
}

interface KeyRow {
  id: string
  venue: VenueId
  label: string
  walletAddress: string | null
  proxyAddress: string | null
  last4: string | null
  status: KeyStatus
  savedAt: string
  verifiedAt: string | null
  tradingEnabledAt: string | null
  revokedAt: string | null
  lastError: string | null
}

// EXACT status labels + colors — do not paraphrase.
const STATUS_LABEL: Record<KeyStatus, string> = {
  NOT_CONNECTED: 'NOT CONNECTED',
  VERIFIED_READ_ONLY: 'VERIFIED · READ-ONLY',
  VERIFIED_TRADING: 'VERIFIED · TRADING',
}
const STATUS_CLASS: Record<KeyStatus, string> = {
  NOT_CONNECTED: 'bg-line/40 text-muted',
  VERIFIED_READ_ONLY: 'bg-mint-tint text-mint-deep',
  VERIFIED_TRADING: 'bg-amber-100 text-amber-800',
}

const WALLET_WARNING =
  'Use a dedicated wallet holding only your operating capital. A wallet private key cannot be revoked.'

// The form stores ONLY the L2 API credentials (they can cancel and read, but cannot sign an order). The
// raw wallet signing key is NEVER entered here — a private key should never traverse a browser form — it
// is stored once from the server CLI. Shown verbatim in the Polymarket form.
const POLY_SIGNING_KEY_NOTE =
  'This form stores only your L2 API credentials (key / secret / passphrase) — they can cancel and read but cannot place an order. Your raw wallet signing key is never entered here; it is stored once from the server CLI (polymarket-maker-store-key), because a private key should never pass through a browser.'

// Which secret fields each venue needs, in order. Wallet address is handled separately
// as a PUBLIC text input.
const SECRET_FIELDS: Record<VenueId, { key: string; label: string; name: string }[]> = {
  kalshi: [
    { key: 'apiKey', label: 'API key ID', name: 'kalshi-api-key' },
    { key: 'apiSecret', label: 'RSA private key (PEM)', name: 'kalshi-api-secret' },
  ],
  polymarket: [
    { key: 'apiKey', label: 'API key', name: 'pm-api-key' },
    { key: 'apiSecret', label: 'API secret', name: 'pm-api-secret' },
    { key: 'passphrase', label: 'Passphrase', name: 'pm-passphrase' },
  ],
}

export default function KeysClient() {
  const router = useRouter()
  const [venues, setVenues] = useState<Venue[]>([])
  const [rows, setRows] = useState<KeyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [openVenue, setOpenVenue] = useState<VenueId | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [okMsg, setOkMsg] = useState('')

  // Per-row transient state.
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})

  async function load() {
    try {
      const r = await fetch('/api/settings/keys')
      if (r.status === 401) {
        router.push('/settings/login')
        return
      }
      if (!r.ok) {
        setLoadError('Could not load credentials.')
        setLoading(false)
        return
      }
      const d = await r.json()
      setVenues(d.venues || [])
      setRows(d.rows || [])
    } catch {
      setLoadError('Could not load credentials.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openForm(v: VenueId) {
    setOpenVenue(v)
    setForm({})
    setFormError('')
    setOkMsg('')
  }

  async function connect(v: VenueId) {
    setBusy(true)
    setFormError('')
    setOkMsg('')
    try {
      const body: Record<string, string> = {
        venue: v,
        label: form.label?.trim() || `${v} key`,
      }
      for (const f of SECRET_FIELDS[v]) {
        if (form[f.key]) body[f.key] = form[f.key]
      }
      if (v === 'polymarket' && form.walletAddress) body.walletAddress = form.walletAddress
      const r = await fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setFormError(d.error || 'Could not save this credential.')
        return
      }
      setOkMsg(`Saved ${d.label} — ending ····${d.last4 ?? '????'}. Now run Test read-only to verify it.`)
      setForm({})
      setOpenVenue(null)
      await load()
    } catch {
      setFormError('Could not save this credential.')
    } finally {
      setBusy(false)
    }
  }

  async function verify(id: string, action: 'read' | 'enable-trading') {
    setRowBusy((s) => ({ ...s, [id]: true }))
    setRowError((s) => ({ ...s, [id]: '' }))
    try {
      const r = await fetch(`/api/settings/keys/${id}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || d.ok === false) {
        const detail = d.detail ? ` (${d.detail})` : ''
        setRowError((s) => ({ ...s, [id]: (d.error || 'Verification failed.') + detail }))
      }
      await load()
    } catch {
      setRowError((s) => ({ ...s, [id]: 'Verification failed.' }))
    } finally {
      setRowBusy((s) => ({ ...s, [id]: false }))
    }
  }

  async function revoke(id: string) {
    setRowBusy((s) => ({ ...s, [id]: true }))
    setRowError((s) => ({ ...s, [id]: '' }))
    try {
      const r = await fetch(`/api/settings/keys/${id}`, { method: 'DELETE' })
      if (!r.ok) setRowError((s) => ({ ...s, [id]: 'Could not revoke.' }))
      await load()
    } finally {
      setRowBusy((s) => ({ ...s, [id]: false }))
    }
  }

  async function logout() {
    await fetch('/api/settings/login', { method: 'DELETE' }).catch(() => {})
    router.push('/settings/login')
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-10">
        <p className="font-body text-sm text-muted">Loading…</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-6 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Venue credentials</h1>
          <p className="font-body text-sm text-muted mt-1">
            Store Polymarket and Kalshi API credentials for the maker/rewards lane. Verification is a
            two-step process and nothing is armed here.
          </p>
        </div>
        <button
          onClick={logout}
          className="shrink-0 min-h-[44px] px-3 rounded-button border border-line font-body text-xs text-ink hover:border-mint/60"
        >
          Sign out
        </button>
      </div>

      {/* Global wallet warning — shown once at top, verbatim. */}
      <div className={cardClass}>
        <p className="font-body text-xs font-semibold text-muted uppercase tracking-widest">
          Before you connect
        </p>
        <p className="font-body text-sm text-ink">{WALLET_WARNING}</p>
        <p className="font-body text-xs text-muted">
          <span className="font-semibold">Test read-only</span> makes a harmless authenticated read
          at the venue — a key becomes verified only on a real success.{' '}
          <span className="font-semibold">Enable trading</span> is a separate, explicit step that
          records your intent; it does NOT place any order or arm any maker.
        </p>
      </div>

      {loadError && (
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="font-body text-sm text-coral-ink">{loadError}</p>
        </div>
      )}
      {okMsg && (
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="font-body text-sm text-ink">{okMsg}</p>
        </div>
      )}

      {venues.map((v) => {
        const mine = rows.filter((k) => k.venue === v.id)
        const isPoly = v.id === 'polymarket'
        return (
          <div key={v.id} className={cardClass}>
            <div className="flex items-center justify-between gap-3">
              <p className="font-display font-bold text-lg text-ink">{v.label}</p>
              {openVenue !== v.id && (
                <button
                  onClick={() => openForm(v.id)}
                  className="shrink-0 min-h-[44px] px-3 rounded-button bg-mint text-white font-body text-sm font-semibold"
                >
                  Add credential
                </button>
              )}
            </div>

            {/* Existing rows */}
            {mine.length === 0 && openVenue !== v.id && (
              <p className="font-body text-xs text-muted">No credential stored yet.</p>
            )}

            {mine.length > 0 && (
              <div className="space-y-3">
                {mine.map((k) => {
                  const canEnableTrading = k.status === 'VERIFIED_READ_ONLY'
                  const rBusy = !!rowBusy[k.id]
                  return (
                    <div key={k.id} className="border-t border-line pt-3 space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-body text-sm text-ink truncate">
                            {k.label} · ····{k.last4 ?? '????'}
                          </p>
                          <p className="font-body text-xs text-muted mt-0.5">
                            Saved {new Date(k.savedAt).toLocaleString()}
                          </p>
                          {/* Polymarket is TWO addresses: show both, labelled, so the empty signer is
                              never mistaken for "the wallet". The proxy holds the funds; the signer signs. */}
                          {k.proxyAddress ? (
                            <>
                              <p className="font-body text-xs text-muted mt-0.5 break-all">
                                <span className="font-semibold">proxy</span> (detiene i fondi, è il «maker») {k.proxyAddress}
                              </p>
                              <p className="font-body text-xs text-muted mt-0.5 break-all">
                                <span className="font-semibold">firmatario</span> (firma, saldo vuoto) {k.walletAddress ?? '—'}
                              </p>
                            </>
                          ) : k.walletAddress ? (
                            <p className="font-body text-xs text-muted mt-0.5 break-all">wallet {k.walletAddress}</p>
                          ) : null}
                        </div>
                        <span
                          className={`shrink-0 px-2 py-1 rounded-button font-body text-xs font-semibold ${STATUS_CLASS[k.status]}`}
                        >
                          {STATUS_LABEL[k.status]}
                        </span>
                      </div>

                      {rowError[k.id] && (
                        <p className="font-body text-xs text-coral-ink break-words">{rowError[k.id]}</p>
                      )}

                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => verify(k.id, 'read')}
                          disabled={rBusy}
                          className="min-h-[44px] px-3 rounded-button bg-mint text-white font-body text-xs font-semibold disabled:opacity-50"
                        >
                          {rBusy ? 'Working…' : 'Test read-only'}
                        </button>
                        {/* Visually SEPARATE, secondary — enabled only after a read-only pass. */}
                        <button
                          onClick={() => verify(k.id, 'enable-trading')}
                          disabled={rBusy || !canEnableTrading}
                          title={
                            canEnableTrading
                              ? 'Records intent only — does not arm any maker or place an order'
                              : 'Run Test read-only first'
                          }
                          className="min-h-[44px] px-3 rounded-button border border-amber-300 bg-amber-50 text-amber-800 font-body text-xs font-semibold disabled:opacity-40"
                        >
                          Enable trading
                        </button>
                        <button
                          onClick={() => revoke(k.id)}
                          disabled={rBusy}
                          className="min-h-[44px] px-3 rounded-button border border-line font-body text-xs text-ink hover:border-mint/60 disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Cosa significa ogni stato — in chiaro, così il badge non promette più di ciò che è provato. */}
            {mine.length > 0 && (
              <div className="border-t border-line pt-3 mt-3 space-y-1">
                <p className="font-body text-xs text-muted">
                  <span className="font-semibold text-ink">NOT CONNECTED</span> — nessuna verifica riuscita: le credenziali non sono state ancora provate contro il venue.
                </p>
                <p className="font-body text-xs text-muted">
                  <span className="font-semibold text-ink">VERIFIED · READ-ONLY</span> — una lettura autenticata è riuscita: queste credenziali L2 leggono e cancellano, ma non firmano ordini.
                </p>
                <p className="font-body text-xs text-muted">
                  <span className="font-semibold text-ink">VERIFIED · TRADING</span> — l’operatore ha registrato l’<em>intento</em> di trading su queste credenziali L2. NON arma il maker, non piazza nulla, e da solo NON prova che il proxy sia finanziato o approvato: quei fatti on-chain (saldo pUSD e approvazioni sul <span className="font-semibold">proxy</span>) li mostra il preflight del maker (<code>scripts/maker-wallet-preflight.ts</code>), non questo badge.
                </p>
              </div>
            )}

            {/* Connect form */}
            {openVenue === v.id && (
              <div className="space-y-3 border-t border-line pt-4">
                <input
                  className={inputClass}
                  placeholder="Label (e.g. main account)"
                  autoComplete="off"
                  value={form.label || ''}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                />

                {/* Wallet address — PUBLIC, plain text input (polymarket only). */}
                {isPoly && (
                  <div className="space-y-1">
                    <label className="font-body text-xs text-muted">
                      Wallet address (public — displayable)
                    </label>
                    <input
                      className={inputClass}
                      type="text"
                      name="wallet-address"
                      autoComplete="off"
                      placeholder="0x… operating wallet address"
                      value={form.walletAddress || ''}
                      onChange={(e) => setForm({ ...form, walletAddress: e.target.value })}
                    />
                    <p className="font-body text-xs text-gold leading-relaxed">{WALLET_WARNING}</p>
                    <p className="font-body text-xs text-muted leading-relaxed">{POLY_SIGNING_KEY_NOTE}</p>
                  </div>
                )}

                {/* Secret fields — password inputs, autocomplete off, non-autofilling names. */}
                {SECRET_FIELDS[v.id].map((f) => (
                  <input
                    key={f.key}
                    className={inputClass}
                    type="password"
                    name={f.name}
                    autoComplete="off"
                    placeholder={f.label}
                    value={form[f.key] || ''}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  />
                ))}

                {formError && <p className="font-body text-sm text-coral-ink">{formError}</p>}

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => connect(v.id)}
                    disabled={busy}
                    className="min-h-[44px] px-3 rounded-button bg-mint text-white font-body text-sm font-semibold disabled:opacity-50"
                  >
                    {busy ? 'Saving…' : 'Save credential'}
                  </button>
                  <button
                    onClick={() => {
                      setOpenVenue(null)
                      setForm({})
                      setFormError('')
                    }}
                    className="min-h-[44px] px-3 rounded-button border border-line font-body text-sm text-ink"
                  >
                    Cancel
                  </button>
                </div>
                <p className="font-body text-xs text-muted">
                  Saved credentials are encrypted at rest. This page only ever shows the last 4
                  characters — never the stored secret.
                </p>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
