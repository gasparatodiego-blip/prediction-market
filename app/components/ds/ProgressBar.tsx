import type { SurfacePrefix } from './tokens';

/**
 * A single-track progress bar used in opposite directions by the two surfaces:
 *
 *   mode="drain" (Sport Arb) — width DEPLETES as the quote's verified-live window runs
 *     out; crosses to amber via `.is-dying` under the caller's threshold.
 *   mode="fill"  (Cash & Carry) — width GROWS as the contract matures toward settlement;
 *     crosses to green via `.is-maturing` past halfway.
 *
 * The DOM is the same in both cases; only the modifier class differs, which is exactly how
 * both tabs already rendered it. The bar carries no logic — `pct` and `active` are computed
 * by the caller, because the threshold is a domain decision, not a presentation one.
 */
export function ProgressBar({ prefix, pct, mode, active }: {
  prefix: SurfacePrefix;
  /** 0–100, already clamped by the caller */
  pct: number;
  mode: 'drain' | 'fill';
  /** drain → `.is-dying` (amber); fill → `.is-maturing` (green) */
  active: boolean;
}) {
  const modifier = mode === 'drain' ? 'is-dying' : 'is-maturing';
  return (
    <div className={`${prefix}-bar`} aria-hidden>
      <div
        className={`${prefix}-bar-fill${active ? ` ${modifier}` : ''}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
