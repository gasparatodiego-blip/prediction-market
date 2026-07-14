'use client';

// Landing-only client visuals for the "live field" re-skin. Renders NO figures
// of its own — the cycling card shows server-rendered opportunity faces passed
// as children (each built from buildLiveRows(), untouched). This file only
// animates: the scanned-market field, the scan sweep, and the 3.6s card cycle.
import {
  Children,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import skin from '@/app/landing-skin.module.css';
import { tierColor } from './tier-color';

// Deterministic PRNG so server and client render the identical field (no
// hydration mismatch, no Math.random). Fixed seed → stable layout.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Curated glow anchors — nicely spread, kept away from the text column's centre.
const GLOW_ANCHORS: Array<[number, number]> = [
  [68, 26], [82, 52], [58, 70], [90, 34], [74, 80],
  [48, 22], [86, 68], [63, 44], [78, 16], [54, 58],
  [92, 82], [70, 62],
];

const FIELD_N = 340;

export function HeroField({ count, tiers }: { count: number; tiers: string[] }) {
  const dims = useMemo(() => {
    const rng = mulberry32(0x5eed42);
    const pts: Array<{ x: number; y: number; s: number; o: number; small: boolean }> = [];
    for (let i = 0; i < FIELD_N; i++) {
      const s = 1 + rng() * 1.9;
      pts.push({
        x: rng() * 100,
        y: rng() * 100,
        s,
        o: 0.12 + rng() * 0.36,
        small: s < 1.9,          // thinned out on mobile
      });
    }
    return pts;
  }, []);

  return (
    <div className={skin.field} aria-hidden>
      {dims.map((p, i) => (
        <span
          key={`d${i}`}
          className={`${skin.point} ${p.small ? skin.small : ''}`}
          style={{
            left: `${p.x}%`, top: `${p.y}%`,
            width: p.s, height: p.s,
            background: 'var(--dim)', opacity: p.o,
          }}
        />
      ))}
      {Array.from({ length: count }).map((_, i) => {
        const [x, y] = GLOW_ANCHORS[i % GLOW_ANCHORS.length];
        const c = tierColor(tiers[i] ?? 'cashable');
        return (
          <span
            key={`g${i}`}
            className={`${skin.point} ${skin.glow}`}
            style={{
              left: `${x}%`, top: `${y}%`,
              width: 6, height: 6,
              background: c,
              boxShadow: `0 0 16px 3px ${c}`,
              animationDelay: `${(i * 0.55).toFixed(2)}s`,
            }}
          />
        );
      })}
      <div className={skin.sweep} />
    </div>
  );
}

export function CyclingCard({
  tiers,
  caption,
  children,
}: {
  tiers: string[];
  caption: ReactNode;
  children: ReactNode;
}) {
  const faces = Children.toArray(children);
  const n = faces.length;
  const [idx, setIdx] = useState(0);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (n <= 1 || reduced.current) return;
    const t = setInterval(() => setIdx(i => (i + 1) % n), 3600);
    return () => clearInterval(t);
  }, [n]);

  if (n === 0) {
    return (
      <div className={skin.card}>
        <div className={skin.cardEmpty}>
          <span className={skin.cardEmptyBig}>Nothing tonight.</span>
          <span className={skin.cardUnit}>
            0 cashable · the field is dark — that&apos;s the honest result, not an error.
          </span>
        </div>
        <p className={skin.cardCaption}>{caption}</p>
      </div>
    );
  }

  const active = Math.min(idx, n - 1);
  const c = tierColor(tiers[active] ?? 'cashable');

  return (
    <div id="tonight" className={skin.card} style={{ boxShadow: `0 20px 60px -20px ${c}66` }}>
      <div className={skin.cardFaces}>{faces[active]}</div>

      {n > 1 && (
        <div className={skin.cardBars}>
          {faces.map((_, i) => (
            <button
              key={i}
              className={`${skin.bar} ${i === active ? skin.barActive : ''}`}
              style={i === active ? { background: c } : undefined}
              onClick={() => setIdx(i)}
              aria-label={`Show opportunity ${i + 1} of ${n}`}
              aria-current={i === active}
            />
          ))}
        </div>
      )}

      <p className={skin.cardCaption}>{caption}</p>
    </div>
  );
}
