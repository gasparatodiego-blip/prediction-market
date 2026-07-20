'use client';

import type { SurfacePrefix } from './tokens';

/**
 * AUTO-FIRE / AUTO-EXECUTE toggle.
 *
 * WIRED TO NOTHING, BY DESIGN. This is a visual armed state only: no account is linked, no
 * order is placed, and no credential is read anywhere in this component. It exists to show
 * what an armed state would look like. The caller owns the boolean; this renders it.
 */
export function ArmToggle({ prefix, armed, onToggle, onLabel, offLabel, title }: {
  prefix: SurfacePrefix;
  armed: boolean;
  onToggle: () => void;
  onLabel: string;
  offLabel: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`${prefix}-arm${armed ? ' is-armed' : ''}`}
      title={title}
      aria-pressed={armed}
    >
      <span className={`${prefix}-arm-dot${armed ? ' is-armed' : ''}`} aria-hidden />
      {armed ? onLabel : offLabel}
    </button>
  );
}
