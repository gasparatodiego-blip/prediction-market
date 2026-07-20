import type { ReactNode } from 'react';
import type { SurfacePrefix } from './tokens';

/**
 * Dark-surface chip.
 *
 * NOT related to app/components/ui/EdgeChip.tsx — that is the pre-existing LIGHT-theme
 * chip used by the older tabs (Prediction, Sports) and is deliberately left untouched.
 * Two separate components on purpose: they belong to two different visual systems, and
 * merging them would drag the light theme onto these panels.
 */
export function Chip({ prefix, amber = false, children }: {
  prefix: SurfacePrefix;
  /** amber variant — used for the "below risk-free" warning state */
  amber?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`${prefix}-chip${amber ? ' is-amber' : ''}`}>{children}</span>
  );
}
