'use client';
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';

// Styling lifted verbatim from app/dashboard/account/page.tsx — this page restyles nothing.
const inputClass = 'w-full px-3 py-2 rounded-button bg-surface border border-line text-ink font-body text-sm focus:outline-none focus:border-mint/60 placeholder:text-muted';
const cardClass  = 'rounded-card border border-line bg-surface p-5 space-y-4 shadow-card';

type CredField = 'apiKey' | 'secret' | 'passphrase';
type PlainField = 'accountAddress' | 'accountId' | 'subaccountNumber';

interface VenueDisclosure {
  state: 'withdrawal_unknown' | 'withdrawal_capable' | 'read_only';
  body: string;
  ack: string;
  addressWhitelistUrl?: string;
  ipWhitelistUrl?: string;
  whitelistReadable: boolean;
}

interface Venue {
  id: string;
  label: string;
  requiredFields: CredField[];
  requiredPlainFields: PlainField[];
  withdrawalPolicy: 'refuse' | 'accept_and_disclose' | 'read_only';
  liveVerified: boolean;
  mainnetOnly: boolean;
  note: string;
  disclosure: VenueDisclosure | null;
}

interface KeyRow {
  id: string;
  venue: string;
  label: string;
  permissionsAtVerify: string[];
  verifiedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  last4: string | null;
}

const FIELD_LABEL: Record<CredField, string> = {
  apiKey: 'API key',
  secret: 'API secret',
  passphrase: 'Passphrase',
};

// Non-secret identifiers are rendered as PLAIN text inputs (not password) because
// they are public — a bech32 address, an id — and not credentials.
const PLAIN_FIELD_LABEL: Record<PlainField, string> = {
  accountAddress: 'Account address (dydx1…)',
  accountId: 'Authenticator id',
  subaccountNumber: 'Subaccount number (default 0)',
};

// Per-venue overrides. A generic "API secret" / "Account address (dydx1…)" is WRONG and
// dangerous for a venue whose secret is a raw private key: the copy must make it
// impossible to paste the WALLET key by mistake. Fall back to the generic label above.
const VENUE_FIELD_LABEL: Record<string, Partial<Record<CredField, string>>> = {
  paradex: { secret: 'Paradex Subkey private key (0x…)' },
};
const VENUE_PLAIN_LABEL: Record<string, Partial<Record<PlainField, string>>> = {
  paradex: { accountAddress: 'Paradex account address (0x…)' },
};
function fieldLabel(venueId: string, f: CredField): string {
  return VENUE_FIELD_LABEL[venueId]?.[f] ?? FIELD_LABEL[f];
}
function plainLabel(venueId: string, f: PlainField): string {
  return VENUE_PLAIN_LABEL[venueId]?.[f] ?? PLAIN_FIELD_LABEL[f];
}

// A per-venue safety note shown above the credential fields. For any venue whose secret
// is a delegated PRIVATE KEY, this must say plainly: this is the delegated trading key,
// NOT your wallet key — and we must never ask for the wallet key.
const VENUE_HINT: Record<string, string> = {
  paradex:
    'Paste your Paradex Subkey — the delegated trading key that CANNOT withdraw or transfer. ' +
    'Create it in Paradex under Key Management → Subkeys. This is NOT your wallet private key ' +
    'and NOT your main account key; never paste either of those.',
};

/**
 * Connection states (UNSUPPORTED is gone — no venue is permanently unsupported now; the
 * withdrawal POLICY, not a guard flag, decides how a venue is handled):
 *   NOT VERIFIED — the adapter has never been run against the real venue. Pending.
 *   NO KEY / CONNECTED — normal states once a venue is live-verified.
 */
function venueState(v: Venue, keys: KeyRow[]): 'NOT VERIFIED' | 'NO KEY' | 'CONNECTED' {
  if (!v.liveVerified) return 'NOT VERIFIED';
  return keys.some((k) => k.venue === v.id && !k.revokedAt) ? 'CONNECTED' : 'NO KEY';
}

const STATE_CLASS: Record<string, string> = {
  'NOT VERIFIED': 'bg-line/40 text-muted',
  'NO KEY':      'bg-line/40 text-muted',
  CONNECTED:     'bg-mint-tint text-mint-deep',
};

// The disclosure headline shown per non-refuse venue — its own chip, distinct from the
// connection state. Never implies WE block anything.
const DISCLOSURE_LABEL: Record<VenueDisclosure['state'], string> = {
  withdrawal_unknown: 'WITHDRAWAL PERMISSION UNKNOWN',
  withdrawal_capable: 'CAN WITHDRAW — DISCLOSED',
  read_only: 'READ-ONLY',
};
const DISCLOSURE_CLASS: Record<VenueDisclosure['state'], string> = {
  withdrawal_unknown: 'bg-amber-100 text-amber-800',
  withdrawal_capable: 'bg-amber-100 text-amber-800',
  read_only: 'bg-mint-tint text-mint-deep',
};

// Gate.io alone lets us MEASURE the IP whitelist. Render the marker permissionsAtVerify
// carries. Everything else says "cannot verify" — never "enabled" for an unread state.
function ipWhitelistLine(perms: string[]): string | null {
  if (perms.includes('ip-whitelist:includes-server')) return 'IP whitelist: set, and includes our server ✓ (read from the venue)';
  if (perms.includes('ip-whitelist:excludes-server')) return 'IP whitelist: set, but does NOT include our server ✗ (read from the venue)';
  if (perms.includes('ip-whitelist:none')) return 'IP whitelist: not set (read from the venue) — anyone with the key can use it from any IP';
  return null;
}

export default function KeysClient() {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/auth/login');
  }, [status, router]);

  const [venues, setVenues] = useState<Venue[]>([]);
  const [keys, setKeys]     = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [openVenue, setOpenVenue] = useState<string | null>(null);
  const [form, setForm]   = useState<Record<string, string>>({});
  const [ack, setAck]     = useState(false); // disclosure acknowledgement, reset per venue
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  const [okMsg, setOkMsg] = useState('');

  async function load() {
    const r = await fetch('/api/keys');
    if (!r.ok) { setLoading(false); return; }
    const d = await r.json();
    setVenues(d.venues || []);
    setKeys(d.keys || []);
    setLoading(false);
  }
  useEffect(() => { if (status === 'authenticated') load(); }, [status]);

  async function connect(v: Venue) {
    setBusy(true); setError(''); setOkMsg('');
    try {
      const body: Record<string, string | number | boolean> = { venue: v.id, label: form.label || `${v.label} key` };
      for (const f of v.requiredFields) body[f] = form[f] || '';
      for (const f of v.requiredPlainFields || []) {
        if (!form[f]) continue;
        body[f] = f === 'subaccountNumber' ? Number(form[f]) : form[f];
      }
      // The disclosure acknowledgement, for non-refuse venues. The server re-checks it.
      if (v.disclosure) body.acknowledged = ack;
      const r = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Could not connect this key.'); return; }
      setOkMsg(`Connected ${d.label} — key ending ${d.last4}. Permissions found: ${(d.permissionsAtVerify || []).join(', ') || 'none reported'}.`);
      setForm({}); setOpenVenue(null);
      await load();
    } catch {
      setError('Could not connect this key.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true); setError('');
    try {
      const r = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
      if (!r.ok) setError('Could not revoke that key.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (status === 'loading' || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex gap-1.5">
          <div className="w-2 h-2 bg-mint rounded-full animate-bounce" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-6 space-y-5">
      <div>
        <h1 className="font-display font-bold text-2xl text-ink">Exchange keys</h1>
        <p className="font-body text-sm text-muted mt-1">
          Connect a read-only exchange API key so Edgeradar can read your balance and positions.
          Edgeradar never places orders.
        </p>
      </div>

      {/* The safety rule, stated plainly and up front — not buried in a tooltip. */}
      <div className={cardClass}>
        <p className="font-body text-xs font-semibold text-muted uppercase tracking-widest">
          Before you connect
        </p>
        <p className="font-body text-sm text-ink">
          Edgeradar never places orders. What we store depends on the venue.
        </p>
        <p className="font-body text-xs text-muted">
          For most venues we verify the key cannot withdraw and refuse it otherwise. For a few, we
          cannot verify that — the key may be able to move funds, or the credential is read-only.
          Those are stored only after you read the disclosure and acknowledge it. Edgeradar cannot
          prevent a withdrawal — the venue enforces key permissions, and the real protection (your
          own withdrawal-address and IP whitelists at the venue) is yours to set.
        </p>
      </div>

      {error && (
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="font-body text-sm text-ink">{error}</p>
        </div>
      )}
      {okMsg && (
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="font-body text-sm text-ink">{okMsg}</p>
        </div>
      )}

      {venues.map((v) => {
        const state = venueState(v, keys);
        const mine  = keys.filter((k) => k.venue === v.id);
        const canConnect = state === 'NO KEY' || state === 'CONNECTED';

        return (
          <div key={v.id} className={cardClass}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-display font-bold text-lg text-ink">{v.label}</p>
                <p className="font-body text-xs text-muted mt-0.5">{v.note}</p>
              </div>
              <div className="shrink-0 flex flex-col items-end gap-1">
                <span className={`px-2 py-1 rounded-button font-body text-xs font-semibold ${STATE_CLASS[state]}`}>
                  {state}
                </span>
                {v.disclosure && (
                  <span className={`px-2 py-0.5 rounded-button font-body text-[10px] font-bold tracking-wide ${DISCLOSURE_CLASS[v.disclosure.state]}`}>
                    {DISCLOSURE_LABEL[v.disclosure.state]}
                  </span>
                )}
              </div>
            </div>

            {mine.length > 0 && (
              <div className="space-y-2">
                {mine.map((k) => (
                  <div key={k.id} className="flex items-center justify-between gap-3 border-t border-line pt-3">
                    <div className="min-w-0">
                      <p className="font-body text-sm text-ink truncate">
                        {k.label} · ····{k.last4 ?? '????'}
                      </p>
                      <p className="font-body text-xs text-muted mt-0.5">
                        {k.revokedAt
                          ? `Revoked ${new Date(k.revokedAt).toLocaleDateString()}`
                          : `Permissions at last check${k.verifiedAt ? ` (${new Date(k.verifiedAt).toLocaleDateString()})` : ''}: ${k.permissionsAtVerify.join(', ') || 'none reported'}`}
                      </p>
                      {/* Gate.io: the MEASURED IP-whitelist state, read from the venue. */}
                      {!k.revokedAt && ipWhitelistLine(k.permissionsAtVerify) && (
                        <p className="font-body text-[11px] text-muted mt-0.5">{ipWhitelistLine(k.permissionsAtVerify)}</p>
                      )}
                    </div>
                    {!k.revokedAt && (
                      <button
                        onClick={() => revoke(k.id)}
                        disabled={busy}
                        className="shrink-0 px-3 py-1.5 rounded-button border border-line font-body text-xs text-ink hover:border-mint/60 disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {canConnect && openVenue !== v.id && (
              <button
                onClick={() => { setOpenVenue(v.id); setForm({}); setAck(false); setError(''); setOkMsg(''); }}
                className="px-3 py-2 rounded-button bg-mint text-white font-body text-sm font-semibold"
              >
                Connect a key
              </button>
            )}

            {canConnect && openVenue === v.id && (
              <div className="space-y-3 border-t border-line pt-4">
                {/* DISCLOSURE — shown before the fields for non-refuse venues. Never implies
                    WE block a withdrawal; states plainly what the credential can do. */}
                {v.disclosure && (
                  <div className="rounded-card border border-amber-200 bg-amber-50 p-3 space-y-2">
                    <p className={`inline-block px-2 py-0.5 rounded-button font-body text-[10px] font-bold tracking-wide ${DISCLOSURE_CLASS[v.disclosure.state]}`}>
                      {DISCLOSURE_LABEL[v.disclosure.state]}
                    </p>
                    <p className="font-body text-xs text-ink leading-relaxed">{v.disclosure.body}</p>
                    {(v.disclosure.addressWhitelistUrl || v.disclosure.ipWhitelistUrl) && (
                      <p className="font-body text-[11px] text-muted leading-relaxed">
                        The real protection is set at {v.label}:{' '}
                        {v.disclosure.addressWhitelistUrl && (
                          <a href={v.disclosure.addressWhitelistUrl} target="_blank" rel="noopener noreferrer" className="underline text-mint-deep">whitelist your withdrawal addresses</a>
                        )}
                        {v.disclosure.addressWhitelistUrl && v.disclosure.ipWhitelistUrl && ' · '}
                        {v.disclosure.ipWhitelistUrl && (
                          <a href={v.disclosure.ipWhitelistUrl} target="_blank" rel="noopener noreferrer" className="underline text-mint-deep">restrict the key to our server IP 167.233.63.218</a>
                        )}
                        {'. '}
                        {v.disclosure.whitelistReadable
                          ? 'Where the venue lets us read the whitelist, the card shows its state after you connect.'
                          : 'We cannot read these settings back — the card cannot confirm they are enabled.'}
                      </p>
                    )}
                  </div>
                )}
                <input
                  className={inputClass}
                  placeholder="Label (e.g. main account)"
                  value={form.label || ''}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                />
                {/* Per-venue safety note — for venues whose secret is a delegated private
                    key, spells out that it is NOT the wallet key. */}
                {VENUE_HINT[v.id] && (
                  <p className="font-body text-xs text-muted leading-relaxed">{VENUE_HINT[v.id]}</p>
                )}
                {/* Fields come from the adapter's requiredFields() — picking OKX reveals
                    the passphrase field, and Binance is never asked for one. */}
                {v.requiredFields.map((f) => (
                  <input
                    key={f}
                    className={inputClass}
                    type="password"
                    autoComplete="off"
                    placeholder={fieldLabel(v.id, f)}
                    value={form[f] || ''}
                    onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                  />
                ))}
                {/* Non-secret identifiers (dYdX, Paradex): PLAIN text inputs, not password —
                    a public address / id is not a credential. */}
                {(v.requiredPlainFields || []).map((f) => (
                  <input
                    key={f}
                    className={inputClass}
                    type="text"
                    autoComplete="off"
                    placeholder={plainLabel(v.id, f)}
                    value={form[f] || ''}
                    onChange={(e) => setForm({ ...form, [f]: e.target.value })}
                  />
                ))}
                {/* Explicit, per-venue acknowledgement — specific text, not a generic dialog.
                    Required before a non-refuse credential can be stored. */}
                {v.disclosure && (
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                      className="mt-0.5 shrink-0"
                    />
                    <span className="font-body text-xs text-ink leading-relaxed">{v.disclosure.ack}</span>
                  </label>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => connect(v)}
                    disabled={busy || (!!v.disclosure && !ack)}
                    className="px-3 py-2 rounded-button bg-mint text-white font-body text-sm font-semibold disabled:opacity-50"
                  >
                    {busy ? 'Verifying…' : 'Verify and connect'}
                  </button>
                  <button
                    onClick={() => { setOpenVenue(null); setForm({}); setAck(false); }}
                    className="px-3 py-2 rounded-button border border-line font-body text-sm text-ink"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
