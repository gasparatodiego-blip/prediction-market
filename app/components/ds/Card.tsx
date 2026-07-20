import type { ReactNode } from 'react';
import type { SurfacePrefix } from './tokens';

/** Panel wrapper. `.sa-card` and `.cc-card` are byte-identical in globals.css; `.cd-card`
 *  differs only in radius/padding, which the prefix preserves. */
export function Card({ prefix, className = '', children }: {
  prefix: SurfacePrefix;
  className?: string;
  children: ReactNode;
}) {
  return <article className={`${prefix}-card${className ? ` ${className}` : ''}`}>{children}</article>;
}

/** Same panel rendered as a <section> — the carry detail screen stacks sections, not cards. */
export function CardSection({ prefix, className = '', children }: {
  prefix: SurfacePrefix;
  className?: string;
  children: ReactNode;
}) {
  return <section className={`${prefix}-card${className ? ` ${className}` : ''}`}>{children}</section>;
}
