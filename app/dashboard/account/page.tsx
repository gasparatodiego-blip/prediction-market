import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import AccountClient from './AccountClient';

export const dynamic = 'force-dynamic';

/**
 * SERVER-SIDE session gate. Same pattern as app/dashboard/settings/keys/page.tsx.
 *
 * middleware.ts states the product rule: "Dashboard pages are intentionally public —
 * never a login wall on the main dashboard... personal/account routes enforce their own
 * server-side session check." This is a personal route: it is the latter. Applying the
 * existing rule to a page that was missing it — not a new rule, and not extended to any
 * public dashboard page.
 *
 * What was actually wrong: the gate was useEffect + router.push inside the client
 * component, so an anonymous request got HTTP 200, the shell, and the page's JS chunk,
 * and only bounced once React booted. That is a UX redirect, not access control.
 *
 * Worth stating precisely, because it bounds what this fixes: the account MARKUP was
 * never in the anonymous body. SessionProvider has no server-side session, so
 * useSession() reports 'loading' during SSR and the component rendered its spinner
 * branch. So this closes "a 200 and a shell are served to anyone", not "account content
 * leaked" — that was not happening.
 *
 * No props: AccountClient calls useSession() itself, exactly as KeysClient does, so no
 * session object and no field of one crosses to the client that was not already
 * crossing. Its own useEffect redirect is kept as the session-expiry fallback for a
 * page already open — belt and braces, not the gate.
 */
export default async function AccountPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect('/auth/login');
  return <AccountClient />;
}
