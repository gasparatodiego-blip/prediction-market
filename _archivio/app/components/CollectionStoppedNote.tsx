'use client';
// CollectionStoppedNote — the one honest inline note a surface shows when its producing agent has
// been stopped and its data file has frozen. Calm gold house style (matches the "data Nm old" stale
// badge), plain Italian, never an error tone. Renders the last real observation time so the reader
// knows the number is abandoned, not a moment behind. See lib/collection-status.js for the rule.
import { collectionStoppedNoteIt, type LastObs } from '@/lib/collection-status';

export default function CollectionStoppedNote({
  asOf,
  className = '',
}: {
  asOf: LastObs;
  className?: string;
}) {
  return (
    <span
      className={`font-body inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[10px] ${className}`}
      style={{ color: '#b45309', background: '#fff8ef' }}
      role="status"
    >
      <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: '#b45309' }} />
      {collectionStoppedNoteIt(asOf)}
    </span>
  );
}
