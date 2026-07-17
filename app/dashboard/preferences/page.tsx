import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import PreferencesClient from './PreferencesClient';

export const dynamic = 'force-dynamic';

/**
 * SERVER-SIDE session redirect. Same pattern as app/dashboard/account/page.tsx (855bc71)
 * and app/dashboard/settings/keys/page.tsx (27cb8c8).
 *
 * middleware.ts states the product rule: "Dashboard pages are intentionally public —
 * never a login wall on the main dashboard... personal/account routes enforce their own
 * server-side session check." This is a personal route — it renders the signed-in user's
 * own settings from /api/user/preferences — so it is the latter. The main dashboard stays
 * public; the middleware is untouched.
 *
 * NOT A LEAK FIX, and this comment exists so nobody later mistakes it for one. Nothing
 * was leaking: /api/user/preferences already returns 401 to an anonymous caller, and the
 * page rendered a "SIGN IN TO MANAGE PREFERENCES" call-to-action rather than any personal
 * data. That CTA was deliberate, not a bug.
 *
 * This is a UX decision: bounce to the login page instead of rendering a CTA. The
 * behaviour it replaces was correct — it is simply not the behaviour we want, and it
 * makes the route consistent with /dashboard/account.
 *
 * No props: PreferencesClient calls useSession() itself, exactly as AccountClient and
 * KeysClient do, so no session object and no field of one crosses to the client that
 * was not already crossing. Its own unauthenticated branch stays as the session-expiry
 * fallback for a page already open.
 */
export default async function PreferencesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect('/auth/login');
  return <PreferencesClient />;
}
