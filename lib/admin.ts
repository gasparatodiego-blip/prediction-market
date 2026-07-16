import { getServerSession } from 'next-auth';
import { authOptions } from './auth';
import prisma from './prisma';

/**
 * The one admin gate. Every admin surface calls this and nothing else.
 *
 * Authority is the `role` column on the User row — resolved fresh from the DB on
 * every call, keyed by the session's user id. Nothing client-supplied is trusted:
 * no query param, no header, no env-var allowlist, no hard-coded email. A revoked
 * role takes effect on the next request even if the JWT still says 'admin'.
 *
 * Throws on failure; callers may let it bubble (500) or catch it to redirect.
 */
export async function requireAdmin(): Promise<{ id: string; email: string }> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new Error('UNAUTHORIZED');

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, role: true },
  });
  if (!user || user.role !== 'admin') throw new Error('FORBIDDEN');

  return { id: user.id, email: user.email };
}

/** Non-throwing variant, for conditionally rendering admin affordances. */
export async function isAdmin(): Promise<boolean> {
  try {
    await requireAdmin();
    return true;
  } catch {
    return false;
  }
}
