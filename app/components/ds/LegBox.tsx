import type { SurfacePrefix } from './tokens';

/**
 * A venue/leg price box. Three stacked slots inside a colour-accented container.
 *
 * The surfaces order and name their slots differently — sport shows venue / side / price,
 * carry shows label / price / tag — so the slot CLASS SUFFIXES are passed in rather than
 * hardcoded. That keeps the emitted DOM identical to what each tab rendered before.
 */
export function LegBox({ prefix, accent, slots }: {
  prefix: SurfacePrefix;
  /** maps to the `.is-*` accent modifier: exchange/spot blue, prediction violet, future teal */
  accent: 'exch' | 'pred' | 'spot' | 'future';
  /** rendered top→bottom; `cls` is the suffix after `${prefix}-leg-` */
  slots: Array<{ cls: string; text: React.ReactNode }>;
}) {
  return (
    <div className={`${prefix}-leg is-${accent}`}>
      {slots.map((s, i) => (
        <span key={i} className={`${prefix}-leg-${s.cls}`}>{s.text}</span>
      ))}
    </div>
  );
}
