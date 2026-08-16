import type { ReactNode } from 'react';
import EdgeChip, { type EdgeChipVariant } from './EdgeChip';

type TileColor = 'mint' | 'violet' | 'gold';

const TILE_BG: Record<TileColor, string> = {
  mint:   'bg-mint-tint',
  violet: 'bg-violet-tint',
  gold:   'bg-gold-tint',
};

const TILE_TEXT: Record<TileColor, string> = {
  mint:   'text-mint-deep',
  violet: 'text-violet',
  gold:   'text-gold',
};

interface BlipRowProps {
  /** Glyph, emoji, or any React node for the icon tile */
  icon:        ReactNode;
  tileColor?:  TileColor;
  name:        ReactNode;
  sub?:        ReactNode;
  chip?:       EdgeChipVariant;
  /** Primary display value, e.g. "+$42" — or a <Redacted> blur/CTA node for free tier */
  value:       ReactNode;
  /** Small unit label below the value, e.g. "/day · net of fees" */
  unit?:       ReactNode;
  /** 'up' → mint-deep; 'neutral' → ink */
  valueTone?:  'up' | 'neutral';
  className?:  string;
}

export default function BlipRow({
  icon,
  tileColor  = 'mint',
  name,
  sub,
  chip,
  value,
  unit,
  valueTone  = 'neutral',
  className  = '',
}: BlipRowProps) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${className}`}>

      {/* ── Icon tile ──────────────────────────────────────────────────────── */}
      <div
        className={`
          w-10 h-10 flex items-center justify-center rounded-[11px]
          text-base flex-shrink-0
          ${TILE_BG[tileColor]} ${TILE_TEXT[tileColor]}
        `}
        aria-hidden
      >
        {icon}
      </div>

      {/* ── Name + sub-label + optional chip ────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-body font-semibold text-sm text-ink leading-tight">
            {name}
          </span>
          {chip && <EdgeChip variant={chip} />}
        </div>
        {sub && (
          <p className="font-body text-[12px] text-muted leading-tight mt-0.5 truncate">
            {sub}
          </p>
        )}
      </div>

      {/* ── Value + unit ─────────────────────────────────────────────────────── */}
      <div className="text-right flex-shrink-0">
        <div
          className={`font-display font-semibold leading-none ${valueTone === 'up' ? 'text-mint-deep' : 'text-ink'}`}
          style={{ fontSize: 19 }}
        >
          {value}
        </div>
        {unit && (
          <div className="font-body text-[11px] text-muted leading-tight mt-0.5">
            {unit}
          </div>
        )}
      </div>

    </div>
  );
}
