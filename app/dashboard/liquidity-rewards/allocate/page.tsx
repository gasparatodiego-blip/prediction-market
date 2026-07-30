import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /dashboard/liquidity-rewards/allocate — kept ONLY as a redirect.
 *
 * Capital allocation is now the "Alloca capitale" section of the single-page console at
 * /dashboard/liquidity-rewards, so this route no longer renders anything of its own: it forwards to
 * that page with the landing section preselected. Old links, bookmarks and anything that still points
 * here keep working and land exactly where the planner now lives.
 *
 * The planner itself (RewardsAllocatePanel) is unchanged — same component, same read-only endpoints,
 * same plan-not-an-order behaviour. Only where it is mounted moved.
 */
export default function AllocateRedirectPage() {
  redirect('/dashboard/liquidity-rewards?tab=alloca');
}
