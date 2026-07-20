import type { ReactNode } from 'react';
import type { SurfacePrefix } from './tokens';

/**
 * Calm empty state. `.sa-empty` and `.cc-empty` are byte-identical in globals.css.
 *
 * Deliberately not styled as an error: zero live crossings and zero basis rows are the
 * EXPECTED common condition on both surfaces, not a fault.
 */
export function EmptyState({ prefix, title, sub }: {
  prefix: SurfacePrefix;
  title?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className={`${prefix}-empty`}>
      {title && <p className={`${prefix}-empty-title`}>{title}</p>}
      {sub && <p className={`${prefix}-empty-sub`}>{sub}</p>}
    </div>
  );
}
