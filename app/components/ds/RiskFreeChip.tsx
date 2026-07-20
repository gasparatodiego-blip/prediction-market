import { Chip } from './Chip';
import type { SurfacePrefix } from './tokens';

/**
 * "< risk-free X%" — the honest-engine marker for a carry that earns less than a T-bill.
 *
 * Always amber, never suppressed. At the time of writing 35 of 37 live basis rows were
 * below the reference, so this chip is the normal case rather than an exception; the tab
 * shows it instead of letting a green number imply edge that risk-free would beat.
 */
export function RiskFreeChip({ prefix, riskFreePct }: {
  prefix: SurfacePrefix;
  riskFreePct: number;
}) {
  return <Chip prefix={prefix} amber>&lt; risk-free {riskFreePct}%</Chip>;
}
