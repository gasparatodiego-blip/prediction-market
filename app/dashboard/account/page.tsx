'use client';
import { useEffect, useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Toggle from '@/app/components/ui/Toggle';
import {
  ALERT_CATEGORIES, CASHABLE_CATEGORIES, CATEGORY_LABELS,
  DEFAULT_ALERT_PREFS, type AlertPrefs,
} from '@/lib/notification-prefs';

const inputClass = 'w-full px-3 py-2 rounded-button bg-surface border border-line text-ink font-body text-sm focus:outline-none focus:border-mint/60 placeholder:text-muted';
const cardClass  = 'rounded-card border border-line bg-surface p-5 space-y-4 shadow-card';

interface Profile {
  name:           string | null;
  email:          string;
  createdAt:      string;
  telegramChatId: string | null;
}

interface Subscription {
  plan:          string;
  planExpiresAt: string | null;
}

const PLAN_LABEL: Record<string, string> = {
  free:         'Free',
  pro:          'Pro',
  profit_share: 'Profit Share',
};

export default function AccountPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/auth/login');
  }, [status, router]);

  // ── Profile ──────────────────────────────────────────────────────────────
  const [profile, setProfile]         = useState<Profile | null>(null);
  const [nameInput, setNameInput]     = useState('');
  const [nameSaving, setNameSaving]   = useState(false);
  const [nameSaved, setNameSaved]     = useState(false);

  // ── Subscription ─────────────────────────────────────────────────────────
  const [sub, setSub] = useState<Subscription | null>(null);

  // ── Change password ─────────────────────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving]               = useState(false);
  const [pwError, setPwError]                 = useState('');
  const [pwSuccess, setPwSuccess]             = useState(false);

  // ── Notification prefs ──────────────────────────────────────────────────
  const [prefs, setPrefs]               = useState<AlertPrefs>(DEFAULT_ALERT_PREFS);
  const [telegramLinked, setTelegramLinked] = useState(false);
  const [prefsLoading, setPrefsLoading] = useState(true);
  const [prefsSaving, setPrefsSaving]   = useState(false);
  const [prefsSaved, setPrefsSaved]     = useState(false);

  // ── Danger zone ──────────────────────────────────────────────────────────
  const [deleteOpen, setDeleteOpen]     = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting]         = useState(false);
  const [deleteError, setDeleteError]   = useState('');

  useEffect(() => {
    if (status !== 'authenticated') return;
    fetch('/api/user/profile').then(r => r.ok ? r.json() : null).then((data: Profile | null) => {
      if (!data) return;
      setProfile(data);
      setNameInput(data.name ?? '');
    });
    fetch('/api/subscription').then(r => r.ok ? r.json() : null).then((data) => {
      if (data) setSub({ plan: data.plan, planExpiresAt: data.planExpiresAt });
    });
    fetch('/api/user/notification-prefs').then(r => r.ok ? r.json() : null).then((data) => {
      if (!data) { setPrefsLoading(false); return; }
      const { telegramLinked: linked, ...rest } = data;
      setPrefs(rest);
      setTelegramLinked(!!linked);
      setPrefsLoading(false);
    });
  }, [status]);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setNameSaving(true);
    const res = await fetch('/api/user/profile', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: nameInput }),
    });
    setNameSaving(false);
    if (res.ok) {
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(''); setPwSuccess(false); setPwSaving(true);
    const res  = await fetch('/api/user/password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ currentPassword, newPassword, confirmPassword }),
    });
    const data = await res.json().catch(() => ({}));
    setPwSaving(false);
    if (!res.ok) { setPwError(data.error ?? 'Failed to change password'); return; }
    setPwSuccess(true);
    setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    setTimeout(() => setPwSuccess(false), 3000);
  }

  function toggleCategory(cat: typeof ALERT_CATEGORIES[number]) {
    setPrefs(p => ({ ...p, [cat]: !p[cat] }));
  }

  async function savePrefs() {
    setPrefsSaving(true);
    const res = await fetch('/api/user/notification-prefs', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(prefs),
    });
    setPrefsSaving(false);
    if (res.ok) {
      setPrefsSaved(true);
      setTimeout(() => setPrefsSaved(false), 2000);
    }
  }

  async function deleteAccount() {
    setDeleteError(''); setDeleting(true);
    const res = await fetch('/api/user/account', { method: 'DELETE' });
    if (!res.ok) {
      setDeleting(false);
      const data = await res.json().catch(() => ({}));
      setDeleteError(data.error ?? 'Failed to delete account');
      return;
    }
    await signOut({ callbackUrl: '/' });
  }

  if (status === 'loading' || (status === 'authenticated' && !profile)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex gap-1.5">
          {[0, 1, 2].map(i => (
            <div key={i} className="w-2 h-2 bg-mint rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
      </div>
    );
  }

  if (status !== 'authenticated' || !profile) return null;

  const isPaid = sub?.plan === 'pro' || sub?.plan === 'profit_share';
  const initial = (profile.name?.trim()?.[0] ?? profile.email[0] ?? '?').toUpperCase();
  const memberSince = new Date(profile.createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <main className="text-ink">
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-6 space-y-5">
        <h1 className="font-display font-bold text-2xl text-ink">Account</h1>

        {/* 1 — Profile */}
        <section className={cardClass}>
          <h2 className="font-body text-xs font-semibold text-muted uppercase tracking-widest">Profile</h2>
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-mint-tint text-mint-deep font-display font-bold text-xl flex items-center justify-center shrink-0">
              {initial}
            </div>
            <div className="min-w-0">
              <p className="font-body text-sm text-ink truncate">{profile.email}</p>
              <p className="font-body text-xs text-muted mt-0.5">Member since {memberSince}</p>
            </div>
          </div>

          <form onSubmit={saveName} className="flex items-end gap-2">
            <div className="flex-1">
              <label className="block font-body text-xs text-ink-2 uppercase tracking-wide mb-1.5">Display name</label>
              <input
                type="text" value={nameInput} maxLength={100}
                onChange={e => setNameInput(e.target.value)}
                placeholder="Your name" className={inputClass}
              />
            </div>
            <button
              type="submit" disabled={nameSaving || nameInput.trim() === (profile.name ?? '')}
              className="px-4 py-2 rounded-button bg-mint-deep text-white font-body text-sm font-medium hover:bg-mint transition-colors duration-100 disabled:opacity-50 disabled:pointer-events-none"
            >
              {nameSaving ? 'Saving…' : nameSaved ? 'Saved ✓' : 'Save'}
            </button>
          </form>
        </section>

        {/* 2 — Subscription */}
        <section className={cardClass}>
          <h2 className="font-body text-xs font-semibold text-muted uppercase tracking-widest">Subscription</h2>
          {!sub ? (
            <p className="font-body text-sm text-muted">Loading…</p>
          ) : (
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="font-display font-bold text-lg text-ink">{PLAN_LABEL[sub.plan] ?? sub.plan}</p>
                {sub.plan === 'pro' && sub.planExpiresAt && (
                  <p className="font-body text-xs text-muted mt-0.5">
                    Renews {new Date(sub.planExpiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                  </p>
                )}
                {sub.plan === 'profit_share' && (
                  <p className="font-body text-xs text-muted mt-0.5">No monthly fee — billed on tracked profits.</p>
                )}
                {sub.plan === 'free' && (
                  <p className="font-body text-xs text-muted mt-0.5">Top 3 opportunities per scan, 5-minute delay.</p>
                )}
              </div>

              {isPaid ? (
                <button
                  type="button" disabled
                  title="Stripe billing portal is not wired up yet"
                  className="px-4 py-2 rounded-button border border-line text-muted font-body text-sm cursor-not-allowed opacity-60"
                >
                  Manage billing (coming soon)
                </button>
              ) : (
                <Link
                  href="/dashboard/upgrade"
                  className="px-4 py-2 rounded-button bg-violet text-white font-body text-sm font-semibold hover:bg-violet/90 transition-colors duration-100"
                >
                  Upgrade to Pro
                </Link>
              )}
            </div>
          )}
        </section>

        {/* 3 — Change password */}
        <section className={cardClass}>
          <h2 className="font-body text-xs font-semibold text-muted uppercase tracking-widest">Change password</h2>
          <form onSubmit={changePassword} className="space-y-3">
            <div>
              <label className="block font-body text-xs text-ink-2 uppercase tracking-wide mb-1.5">Current password</label>
              <input type="password" required value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className="block font-body text-xs text-ink-2 uppercase tracking-wide mb-1.5">New password</label>
              <input type="password" required minLength={8} value={newPassword} onChange={e => setNewPassword(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className="block font-body text-xs text-ink-2 uppercase tracking-wide mb-1.5">Confirm new password</label>
              <input type="password" required minLength={8} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className={inputClass} />
            </div>

            {pwError   && <p className="font-body text-xs text-coral-ink">{pwError}</p>}
            {pwSuccess && <p className="font-body text-xs text-mint-deep">Password changed successfully.</p>}

            <button
              type="submit" disabled={pwSaving}
              className="px-4 py-2 rounded-button bg-mint-deep text-white font-body text-sm font-medium hover:bg-mint transition-colors duration-100 disabled:opacity-50"
            >
              {pwSaving ? 'Updating…' : 'Update password'}
            </button>
          </form>
        </section>

        {/* 4 — Notifications */}
        <section className={cardClass}>
          <h2 className="font-body text-xs font-semibold text-muted uppercase tracking-widest">Notifications</h2>

          {/* Telegram link card */}
          <div className="rounded-button border border-line bg-bg-soft/40 p-3.5 flex items-center justify-between gap-3">
            <div>
              <p className="font-body text-sm text-ink font-medium">Telegram link</p>
              <p className="font-body text-xs text-muted mt-0.5">Not linked</p>
            </div>
            <button
              type="button" disabled
              title="Telegram linking is coming soon"
              className="px-3.5 py-1.5 rounded-button border border-line text-muted font-body text-xs cursor-not-allowed opacity-60 shrink-0"
            >
              Connect Telegram (coming soon)
            </button>
          </div>

          {/* What to follow */}
          <div>
            <p className="font-body text-xs text-ink-2 uppercase tracking-wide mb-2.5">What to follow</p>
            <div className={`space-y-2.5 ${telegramLinked ? '' : 'opacity-60'}`}>
              {ALERT_CATEGORIES.map(cat => (
                <div key={cat} className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${CASHABLE_CATEGORIES.includes(cat) ? 'bg-mint' : 'bg-violet'}`}
                      aria-hidden
                    />
                    <span className="font-body text-sm text-ink-2">{CATEGORY_LABELS[cat]}</span>
                  </div>
                  <Toggle
                    checked={prefs[cat]}
                    onChange={() => toggleCategory(cat)}
                    dot={CASHABLE_CATEGORIES.includes(cat) ? 'mint' : 'violet'}
                    label={CATEGORY_LABELS[cat]}
                  />
                </div>
              ))}
            </div>
            <p className="font-body text-[11px] text-muted mt-3">Alerts start once Telegram is linked.</p>
          </div>

          {/* 5 — Email digest (same alertPrefs object) */}
          <div className="pt-3 border-t border-line/60 flex items-center justify-between gap-3">
            <div>
              <p className="font-body text-sm text-ink-2">Weekly email digest</p>
              <p className="font-body text-[11px] text-muted mt-0.5">A weekly summary of opportunities, sent by email.</p>
            </div>
            <Toggle
              checked={prefs.emailDigest}
              onChange={() => setPrefs(p => ({ ...p, emailDigest: !p.emailDigest }))}
              dot="mint"
              label="Weekly email digest"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button" onClick={savePrefs} disabled={prefsSaving || prefsLoading}
              className="px-4 py-2 rounded-button bg-mint-deep text-white font-body text-sm font-medium hover:bg-mint transition-colors duration-100 disabled:opacity-50"
            >
              {prefsSaving ? 'Saving…' : prefsSaved ? 'Saved ✓' : 'Save preferences'}
            </button>
          </div>
        </section>

        {/* API key — always disabled regardless of lib/flags.ts AUTO_EXECUTE_ENABLED;
            this commit stores no keys and wires no execution. */}
        <section className={cardClass}>
          <h2 className="font-body text-xs font-semibold text-muted uppercase tracking-widest">API access</h2>
          <div className="rounded-button border border-line bg-bg-soft/40 p-3.5">
            <p className="font-body text-sm text-ink-2">Available on Pro when automation launches</p>
            <p className="font-body text-[11px] text-muted mt-1">
              Auto-execution and API keys are not live yet. No keys are collected or stored by this page.
            </p>
          </div>
        </section>

        {/* 6 — Danger zone */}
        <section className={`${cardClass} border-coral-ink/20`}>
          <h2 className="font-body text-xs font-semibold text-coral-ink uppercase tracking-widest">Danger zone</h2>

          <div className="flex items-center justify-between gap-3">
            <p className="font-body text-sm text-ink-2">Sign out of your account on this device.</p>
            <button
              type="button" onClick={() => signOut({ callbackUrl: '/' })}
              className="px-4 py-2 rounded-button border border-line text-ink-2 font-body text-sm hover:border-mint hover:text-mint-deep transition-colors duration-100 shrink-0"
            >
              Log out
            </button>
          </div>

          <div className="pt-3 border-t border-line/60">
            {!deleteOpen ? (
              <div className="flex items-center justify-between gap-3">
                <p className="font-body text-sm text-ink-2">Permanently delete your account and all data.</p>
                <button
                  type="button" onClick={() => setDeleteOpen(true)}
                  className="px-4 py-2 rounded-button border border-coral-ink/40 text-coral-ink font-body text-sm hover:bg-coral-tint transition-colors duration-100 shrink-0"
                >
                  Delete account
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="font-body text-sm text-ink-2">
                  This permanently deletes your account, portfolio, tracked opportunities and preferences. This cannot be undone.
                </p>
                <p className="font-body text-xs text-ink-2">
                  Type <span className="font-mono font-bold">DELETE</span> to confirm.
                </p>
                <input
                  type="text" value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)}
                  className={inputClass} placeholder="DELETE"
                />
                {deleteError && <p className="font-body text-xs text-coral-ink">{deleteError}</p>}
                <div className="flex items-center gap-2">
                  <button
                    type="button" disabled={deleteConfirm !== 'DELETE' || deleting}
                    onClick={deleteAccount}
                    className="px-4 py-2 rounded-button bg-coral-ink text-white font-body text-sm font-medium hover:bg-coral-ink/90 transition-colors duration-100 disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {deleting ? 'Deleting…' : 'Permanently delete'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setDeleteOpen(false); setDeleteConfirm(''); setDeleteError(''); }}
                    className="px-4 py-2 rounded-button border border-line text-ink-2 font-body text-sm hover:border-mint/40 transition-colors duration-100"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
