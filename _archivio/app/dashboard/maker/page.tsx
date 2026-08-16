import MakerKillClient from './MakerKillClient';

export const dynamic = 'force-dynamic';

/**
 * Maker kill-switch page. Middleware gates this to an authenticated admin session (the SAME
 * ADMIN_ACCESS_SECRET gate as /settings) and 404s the whole lane if no admin secret is configured, so no
 * per-page auth check is needed here. The rest of /dashboard stays public — only /dashboard/maker is gated.
 */
export default function MakerKillSwitchPage() {
  return <MakerKillClient />;
}
