import { redirect, notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/admin';
import { getAdminUsersView, maskEmail, type AdminUserRow } from '@/lib/admin-users';

// Session-dependent + live DB read: never prerender, never cache.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const card = 'rounded-card border border-line bg-surface p-4 shadow-card';
const dash = <span className="text-muted">—</span>;

function fmtDate(d: Date | null): React.ReactNode {
  if (!d) return dash;
  return d.toISOString().slice(0, 10);
}

function Bool({ v }: { v: boolean }) {
  return v ? <span className="text-mint-deep">yes</span> : <span className="text-muted">no</span>;
}

/** Authoritative label for a row's auth method. Both can be set (linked account). */
function authLabel(u: AdminUserRow): React.ReactNode {
  const parts: string[] = [];
  if (u.hasPassword) parts.push('password');
  if (u.hasGoogle) parts.push('google');
  if (parts.length === 0) return <span className="text-coral-ink">none</span>;
  return <>{parts.join(' + ')}</>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={card}>
      <div className="text-xs uppercase tracking-wide text-muted font-body">{label}</div>
      <div className="mt-1 text-2xl text-ink font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function AnomalyBlock({
  n, title, rows, explain, benign,
}: {
  n: number; title: string; rows: AdminUserRow[]; explain: string; benign?: (u: AdminUserRow) => string | null;
}) {
  const clean = rows.length === 0;
  return (
    <div className={`${card} ${clean ? '' : 'border-coral/50'}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold text-ink">
          {n}. {title}
        </div>
        <div className={`text-lg font-semibold tabular-nums ${clean ? 'text-mint-deep' : 'text-coral-ink'}`}>
          {rows.length}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted leading-snug">{explain}</p>
      {rows.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rows.map((u) => {
            const note = benign?.(u) ?? null;
            return (
              <li key={u.id} className="text-xs text-ink-2 break-all">
                {maskEmail(u.email)}
                {note && <span className="text-muted"> — {note}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default async function AdminPage() {
  // ── THE GATE ──────────────────────────────────────────────────────────────
  // Nothing below this line runs — and no query is issued — unless the caller is
  // an admin per the User.role column. requireAdmin() is the only mechanism.
  try {
    await requireAdmin();
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'FORBIDDEN';
    if (reason === 'UNAUTHORIZED') redirect('/auth/login?callbackUrl=/admin');
    notFound(); // signed in but not admin → 404, don't confirm the page exists
  }

  const v = await getAdminUsersView();

  return (
    <main className="min-h-screen bg-bg px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold text-ink">Admin · Users</h1>
          <p className="text-xs text-muted mt-1">
            Read-only. Live from the database on every request — nothing here is cached or
            precomputed.
          </p>
        </header>

        {/* ── Counts ───────────────────────────────────────────────────────── */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Total users" value={v.totalUsers} />
          <Stat label="Admins" value={v.adminCount} />
          <Stat
            label="Plans"
            value={
              <span className="text-sm font-body font-normal">
                {v.planBreakdown.map((p) => `${p.plan}: ${p.count}`).join(' · ')}
              </span>
            }
          />
          <Stat
            label="Leads"
            value={
              <>
                {v.leadCount}
                <span className="block text-xs font-body font-normal text-muted mt-0.5">
                  {v.leadSources.length > 0
                    ? v.leadSources.map((s) => `${s.source}: ${s.count}`).join(' · ')
                    : 'no sources'}
                </span>
              </>
            }
          />
        </section>

        {/* ── Integrity ────────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Data integrity</h2>
            <p className="text-xs text-muted mt-0.5">
              There is no bot or fake-signup signal in this system — nothing is collected that
              could support one. These are the real, actionable anomalies instead. Counted live.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <AnomalyBlock
              n={1}
              title="Cannot authenticate"
              rows={v.anomalies.cannotAuthenticate}
              explain="Neither passwordHash nor googleId is set. These rows can never be logged into by anyone."
            />
            <AnomalyBlock
              n={2}
              title="Missing signup rows"
              rows={v.anomalies.missingSignupRows}
              explain="No UserPreferences and/or Portfolio row. The signup flow always creates both, so these were written directly to the database. Harmless — every write path upserts — but it marks a row as not organically registered."
              benign={(u) => (u.role === 'admin' ? 'the admin account, by design' : null)}
            />
            <AnomalyBlock
              n={3}
              title="Paid plan, no Subscription row"
              rows={v.anomalies.planWithoutSub}
              explain="User.plan is not 'free' but the Subscription audit trail is empty — the two disagree. plan was set directly. This is not evidence of payment either way; Stripe is unwired."
            />
            <AnomalyBlock
              n={4}
              title="Fixture domains"
              rows={v.anomalies.fixtureDomains}
              explain="Reserved, non-deliverable domains (RFC 2606 / 6761): .test, .example, .invalid, example.com. These addresses cannot receive mail, so the rows are fixtures by construction."
            />
          </div>
        </section>

        {/* ── Signup distribution ──────────────────────────────────────────── */}
        <section className={card}>
          <h2 className="text-sm font-semibold text-ink">Signups by day</h2>
          <ul className="mt-2 space-y-1">
            {v.signupsByDay.map((d) => (
              <li key={d.day} className="flex items-center gap-2 text-xs">
                <span className="w-24 shrink-0 tabular-nums text-ink-2">{d.day}</span>
                <span
                  className="h-2 rounded-sm bg-mint/70"
                  style={{ width: `${d.count * 24}px` }}
                  aria-hidden
                />
                <span className="tabular-nums text-muted">{d.count}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Users ────────────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-ink">Users · newest first</h2>

          {/* Mobile: stacked cards (readable at 360px, no horizontal overflow) */}
          <div className="space-y-3 md:hidden">
            {v.users.map((u) => (
              <div key={u.id} className={card}>
                <div className="text-sm text-ink break-all font-medium">{u.email}</div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted">Name</dt>
                  <dd className="text-ink-2 break-all">{u.name ?? dash}</dd>
                  <dt className="text-muted">Role</dt>
                  <dd className="text-ink-2">{u.role}</dd>
                  <dt className="text-muted">Plan</dt>
                  <dd className="text-ink-2">
                    {u.plan} {u.isPaid ? <span className="text-mint-deep">· paid now</span> : <span className="text-muted">· not paid</span>}
                  </dd>
                  <dt className="text-muted">Expires</dt>
                  <dd className="text-ink-2 tabular-nums">{fmtDate(u.planExpiresAt)}</dd>
                  <dt className="text-muted">Auth</dt>
                  <dd className="text-ink-2">{authLabel(u)}</dd>
                  <dt className="text-muted">Telegram</dt>
                  <dd className="text-ink-2"><Bool v={u.hasTelegram} /></dd>
                  <dt className="text-muted">Subs</dt>
                  <dd className="text-ink-2 tabular-nums">{u.subscriptionCount}</dd>
                  <dt className="text-muted">Created</dt>
                  <dd className="text-ink-2 tabular-nums">{fmtDate(u.createdAt)}</dd>
                </dl>
              </div>
            ))}
          </div>

          {/* Desktop: table, scrolls inside its own container if narrow */}
          <div className={`${card} hidden md:block overflow-x-auto p-0`}>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Plan</th>
                  <th className="px-3 py-2 font-medium">Paid now</th>
                  <th className="px-3 py-2 font-medium">Expires</th>
                  <th className="px-3 py-2 font-medium">Auth</th>
                  <th className="px-3 py-2 font-medium">Telegram</th>
                  <th className="px-3 py-2 font-medium">Subs</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {v.users.map((u) => (
                  <tr key={u.id} className="border-b border-line/60 last:border-0">
                    <td className="px-3 py-2 text-ink break-all">{u.email}</td>
                    <td className="px-3 py-2 text-ink-2">{u.name ?? dash}</td>
                    <td className="px-3 py-2 text-ink-2">{u.role}</td>
                    <td className="px-3 py-2 text-ink-2">{u.plan}</td>
                    <td className="px-3 py-2"><Bool v={u.isPaid} /></td>
                    <td className="px-3 py-2 text-ink-2 tabular-nums">{fmtDate(u.planExpiresAt)}</td>
                    <td className="px-3 py-2 text-ink-2">{authLabel(u)}</td>
                    <td className="px-3 py-2"><Bool v={u.hasTelegram} /></td>
                    <td className="px-3 py-2 text-ink-2 tabular-nums">{u.subscriptionCount}</td>
                    <td className="px-3 py-2 text-ink-2 tabular-nums">{fmtDate(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── What this page cannot tell you ───────────────────────────────── */}
        <section className={card}>
          <h2 className="text-sm font-semibold text-ink">Not recorded</h2>
          <p className="mt-1 text-xs text-muted leading-relaxed">
            The schema captures none of the following, so this page does not show them and no
            proxy is computed: last login, session or page activity, IP, geography, user agent,
            device · email verification status (no verification step exists) · trial state (no
            trial concept) · revenue or payment status (<code>plan=&apos;pro&apos;</code> is not
            evidence anyone paid — Stripe is unwired) · any bot or fake-signup score.
          </p>
        </section>
      </div>
    </main>
  );
}
