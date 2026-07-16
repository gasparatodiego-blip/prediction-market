// Server-only: imported exclusively by the /admin server component, after
// requireAdmin() has resolved. Never import this from a client component —
// every field here is admin-restricted.
import prisma from './prisma';

// ── isPaid ──────────────────────────────────────────────────────────────────
// MIRROR of the private isPlanCurrentlyPaid() in lib/paid-gating.ts:40. That
// function is module-private and its only exported wrapper (getIsPaid) resolves
// the CURRENT session's user, so it cannot derive isPaid for an admin listing of
// other rows. This copy must stay byte-identical in behaviour to the original;
// if paid-gating's rule changes, change it here too. The durable fix is to
// export isPlanCurrentlyPaid from paid-gating.ts and delete this copy.
function isPlanCurrentlyPaid(plan: string, planExpiresAt: Date | null, now = new Date()): boolean {
  if (plan === 'profit_share') return true;
  // planExpiresAt is only ever set on 'pro' upgrade (30-day window); a missing
  // value on an existing 'pro' row is a data anomaly, not an expiry — don't punish it.
  if (plan === 'pro') return planExpiresAt ? planExpiresAt > now : true;
  return false;
}

export type AdminUserRow = {
  id:               string;
  email:            string;
  name:             string | null;
  createdAt:        Date;
  plan:             string;
  planExpiresAt:    Date | null;
  role:             string;
  hasPassword:      boolean;
  hasGoogle:        boolean;
  hasTelegram:      boolean;
  missingPrefs:     boolean;
  missingPortfolio: boolean;
  subscriptionCount: number;
  // derived
  isPaid:           boolean;
  canAuthenticate:  boolean;
  isFixtureDomain:  boolean;
  planWithoutSub:   boolean;
};

export type AdminUsersView = {
  users:        AdminUserRow[];
  totalUsers:   number;
  adminCount:   number;
  planBreakdown: { plan: string; count: number }[];
  leadCount:    number;
  leadSources:  { source: string; count: number }[];
  signupsByDay: { day: string; count: number }[];
  anomalies: {
    cannotAuthenticate: AdminUserRow[];
    missingSignupRows:  AdminUserRow[];
    planWithoutSub:     AdminUserRow[];
    fixtureDomains:     AdminUserRow[];
  };
};

/** Reserved / non-deliverable domains — RFC 2606 + RFC 6761. A row on one of
 *  these is a fixture by construction: the domain cannot receive mail. */
const FIXTURE_DOMAIN_RE = /(\.test|\.example|\.invalid|\.localhost)$|^(example\.(com|net|org))$/i;

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '—';
  return `${local[0]}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

type RawRow = {
  id: string; email: string; name: string | null; createdAt: Date;
  plan: string; planExpiresAt: Date | null; role: string;
  has_password: boolean; has_google: boolean; has_telegram: boolean;
  missing_prefs: boolean; missing_portfolio: boolean; subscription_count: number;
};

export async function getAdminUsersView(): Promise<AdminUsersView> {
  // Raw select so passwordHash / googleId never leave the database — only the
  // boolean "is it set" crosses the wire. Never SELECT the hash itself.
  const raw = await prisma.$queryRaw<RawRow[]>`
    SELECT
      u.id, u.email, u.name, u."createdAt", u.plan, u."planExpiresAt", u.role,
      (u."passwordHash"   IS NOT NULL) AS has_password,
      (u."googleId"       IS NOT NULL) AS has_google,
      (u."telegramChatId" IS NOT NULL) AS has_telegram,
      NOT EXISTS (SELECT 1 FROM "UserPreferences" p  WHERE p."userId"  = u.id) AS missing_prefs,
      NOT EXISTS (SELECT 1 FROM "Portfolio"       pf WHERE pf."userId" = u.id) AS missing_portfolio,
      (SELECT COUNT(*) FROM "Subscription" s WHERE s."userId" = u.id)::int      AS subscription_count
    FROM "User" u
    ORDER BY u."createdAt" DESC
  `;

  const now = new Date();
  const users: AdminUserRow[] = raw.map((r) => {
    const domain = r.email.split('@')[1] ?? '';
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      createdAt: r.createdAt,
      plan: r.plan,
      planExpiresAt: r.planExpiresAt,
      role: r.role,
      hasPassword: r.has_password,
      hasGoogle: r.has_google,
      hasTelegram: r.has_telegram,
      missingPrefs: r.missing_prefs,
      missingPortfolio: r.missing_portfolio,
      subscriptionCount: r.subscription_count,
      isPaid: isPlanCurrentlyPaid(r.plan, r.planExpiresAt, now),
      canAuthenticate: r.has_password || r.has_google,
      isFixtureDomain: FIXTURE_DOMAIN_RE.test(domain),
      planWithoutSub: r.plan !== 'free' && r.subscription_count === 0,
    };
  });

  const [leadCount, leadSourcesRaw] = await Promise.all([
    prisma.lead.count(),
    prisma.lead.groupBy({ by: ['source'], _count: true }),
  ]);

  const planCounts = new Map<string, number>();
  for (const u of users) planCounts.set(u.plan, (planCounts.get(u.plan) ?? 0) + 1);

  const dayCounts = new Map<string, number>();
  for (const u of users) {
    const day = u.createdAt.toISOString().slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }

  return {
    users,
    totalUsers: users.length,
    adminCount: users.filter((u) => u.role === 'admin').length,
    planBreakdown: Array.from(planCounts.entries())
      .map(([plan, count]) => ({ plan, count }))
      .sort((a, b) => b.count - a.count),
    leadCount,
    leadSources: leadSourcesRaw
      .map((l) => ({ source: l.source, count: l._count }))
      .sort((a, b) => b.count - a.count),
    signupsByDay: Array.from(dayCounts.entries())
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    anomalies: {
      cannotAuthenticate: users.filter((u) => !u.canAuthenticate),
      missingSignupRows:  users.filter((u) => u.missingPrefs || u.missingPortfolio),
      planWithoutSub:     users.filter((u) => u.planWithoutSub),
      fixtureDomains:     users.filter((u) => u.isFixtureDomain),
    },
  };
}
