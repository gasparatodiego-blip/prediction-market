import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import KeysClient from './KeysClient';

export const dynamic = 'force-dynamic';

/**
 * SERVER-SIDE session gate.
 *
 * middleware.ts states the product rule: "Dashboard pages are intentionally public —
 * never a login wall on the main dashboard... personal/account routes enforce their own
 * server-side session check." This page is the latter, not the former: it is where a
 * user hands over exchange credentials. An unauthenticated request must not even get
 * the shell.
 *
 * Client-side redirection (useEffect + router.push, as on /dashboard/account) still
 * serves HTTP 200 with the page body and only bounces once React boots — that is a
 * UX redirect, not an access control. Gating here returns a redirect BEFORE any markup
 * is rendered.
 *
 * Scoped to this route only. The middleware is untouched and the main dashboard stays
 * public exactly as the product rule requires.
 */
export default async function KeysPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect('/auth/login');
  return <KeysClient />;
}
