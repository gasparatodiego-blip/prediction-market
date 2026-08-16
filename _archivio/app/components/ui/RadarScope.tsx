type BlipColor = 'mint' | 'violet' | 'gold';

export interface Blip {
  top:   string;   // CSS value, e.g. "30%"
  left:  string;   // CSS value, e.g. "60%"
  color: BlipColor;
}

interface RadarScopeProps {
  /** Diameter in px. Default 150. */
  size?:   number;
  blips?:  Blip[];
  className?: string;
}

const BLIP_HEX: Record<BlipColor, string> = {
  mint:   '#0FBE82',
  violet: '#5566D6',
  gold:   '#C8821C',
};

export default function RadarScope({
  size = 150,
  blips = [],
  className = '',
}: RadarScopeProps) {
  const half   = size / 2;
  const hairW  = Math.max(1, Math.round(size * 0.007));

  return (
    <div
      className={`relative rounded-full flex-shrink-0 overflow-hidden ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* ── Concentric-ring background (mint @ 0.12 opacity) ─────────────────── */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            'repeating-radial-gradient(' +
            'circle, ' +
            'transparent 0%, transparent 16%, ' +
            'rgba(15,190,130,.12) 16%, rgba(15,190,130,.12) 17%)',
        }}
      />

      {/* ── Outer rim ──────────────────────────────────────────────────────────── */}
      <div
        className="absolute inset-0 rounded-full"
        style={{ boxShadow: 'inset 0 0 0 1px rgba(15,190,130,.2)' }}
      />

      {/* ── Crosshair hairlines ───────────────────────────────────────────────── */}
      {/* Vertical */}
      <div
        className="absolute"
        style={{
          width:     hairW,
          top:       0,
          bottom:    0,
          left:      half - hairW / 2,
          background: 'rgba(15,190,130,.15)',
        }}
      />
      {/* Horizontal */}
      <div
        className="absolute"
        style={{
          height:    hairW,
          left:      0,
          right:     0,
          top:       half - hairW / 2,
          background: 'rgba(15,190,130,.15)',
        }}
      />

      {/* ── Rotating conic sweep (no-preference motion only) ─────────────────── */}
      <div
        className="absolute inset-0 rounded-full motion-safe:animate-spin"
        style={{
          background:
            'conic-gradient(' +
            'from 0deg, ' +
            'transparent 0deg, ' +
            'rgba(15,190,130,.16) 60deg, ' +
            'transparent 120deg)',
          animationDuration: '6s',
        }}
      />

      {/* ── Blips ────────────────────────────────────────────────────────────── */}
      {blips.map((blip, i) => (
        <span
          key={i}
          className="absolute"
          style={{ top: blip.top, left: blip.left, transform: 'translate(-50%, -50%)' }}
        >
          {/* Ping ring — reduced-motion safe */}
          <span
            className="absolute inset-[-4px] rounded-full motion-safe:animate-er-ping"
            style={{ backgroundColor: BLIP_HEX[blip.color], opacity: 0.35 }}
          />
          {/* Static dot — always visible */}
          <span
            className="relative block w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: BLIP_HEX[blip.color] }}
          />
        </span>
      ))}

      {/* ── Center dot ───────────────────────────────────────────────────────── */}
      <span
        className="absolute rounded-full bg-mint"
        style={{
          width:     6,
          height:    6,
          top:       '50%',
          left:      '50%',
          transform: 'translate(-50%, -50%)',
          boxShadow: '0 0 6px rgba(15,190,130,.6)',
        }}
      />
    </div>
  );
}
