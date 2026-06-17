// CEX spot-price arb is shown on the Crypto & Funding board.
import { redirect } from 'next/navigation';

export default function CEXRedirect() {
  redirect('/dashboard/funding-arb');
}
