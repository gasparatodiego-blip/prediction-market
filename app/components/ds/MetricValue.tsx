import type { ReactNode } from 'react';
import type { SurfacePrefix } from './tokens';

/**
 * The card's headline figure plus its unit caption.
 *
 * The caption is REQUIRED, not optional: an unlabelled big number is how "$0.11" gets read
 * as a percentage or a per-year figure. Both surfaces state the unit and the capital basis
 * in the caption ("net · post-fee", "net · per day / $1,000").
 */
export function MetricValue({ prefix, value, caption, side }: {
  prefix: SurfacePrefix;
  /** already formatted/redacted by the caller — this component does no math */
  value: ReactNode;
  caption: ReactNode;
  /** optional extra column rendered beside the value (carry detail's $/day + %/yr) */
  side?: ReactNode;
}) {
  if (side) {
    return (
      <>
        <span className={`${prefix}-net-label`}>{caption}</span>
        <div className={`${prefix}-net-row`}>
          <span className={`${prefix}-net-val`}>{value}</span>
          <div className={`${prefix}-net-side`}>{side}</div>
        </div>
      </>
    );
  }
  return (
    <div className={`${prefix}-net`}>
      <span className={`${prefix}-net-val`}>{value}</span>
      <span className={`${prefix}-net-cap`}>{caption}</span>
    </div>
  );
}
