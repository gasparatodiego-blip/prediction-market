import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// The "Scheda mercato" is no longer its own page: it is section 7 of the unified market screen, so the
// operator reads the venue rules WITHOUT leaving the book and the controls that act on them. This route
// stays only so existing links and bookmarks land in the right place instead of 404-ing.
export default function EventPageRedirect({ params }: { params: { marketId: string } }) {
  redirect(`/dashboard/liquidity-rewards/${params.marketId}#data`);
}
