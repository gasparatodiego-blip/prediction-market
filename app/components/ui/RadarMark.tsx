interface RadarMarkProps {
  /** Diameter in px. Default 18. */
  size?: number;
  className?: string;
}

export default function RadarMark({ size = 18, className = '' }: RadarMarkProps) {
  const dot = Math.max(3, Math.round(size * 0.22));

  return (
    <span
      className={`relative inline-block flex-shrink-0 rounded-full overflow-hidden ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* Concentric-ring gradient backdrop */}
      <span
        className="absolute inset-0 rounded-full"
        style={{
          background:
            'repeating-radial-gradient(' +
            'circle, ' +
            'transparent 0px, transparent 3px, ' +
            'rgba(15,190,130,.1) 3px, rgba(15,190,130,.1) 4px)',
        }}
      />

      {/* Rotating conic sweep — suppressed under prefers-reduced-motion */}
      <span
        className="absolute inset-0 rounded-full motion-safe:animate-spin"
        style={{
          background:
            'conic-gradient(' +
            'from 0deg, ' +
            'transparent 0deg, ' +
            'rgba(15,190,130,.45) 50deg, ' +
            'transparent 100deg)',
          animationDuration: '3s',
        }}
      />

      {/* Center dot — always visible */}
      <span
        className="absolute rounded-full bg-mint"
        style={{
          width:     dot,
          height:    dot,
          top:       '50%',
          left:      '50%',
          transform: 'translate(-50%, -50%)',
        }}
      />
    </span>
  );
}
