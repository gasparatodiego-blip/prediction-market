import type { ReactNode } from 'react';
import type { SurfacePrefix } from './tokens';

/**
 * The card's top row: identity on the left, a status figure on the right.
 * Sport puts a live pulse + league + clock on the left; carry puts asset/venue/expiry.
 * `left` is a slot so each surface keeps its own content and class names.
 */
export function ScoreboardHeader({ prefix, left, right }: {
  prefix: SurfacePrefix;
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className={`${prefix}-card-head`}>
      {left}
      {right}
    </div>
  );
}
