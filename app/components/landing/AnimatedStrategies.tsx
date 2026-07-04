'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import EdgeChip, { type EdgeChipVariant } from '@/app/components/ui/EdgeChip';
import Eyebrow from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';

// ── Shared hooks ─────────────────────────────────────────────────────────
// All values in this file's animations are illustrative examples for
// motion/UX purposes only — never read from live data or the honest-engine
// pipeline. See the disclaimer rendered at the bottom of the section.

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return reduced;
}

// One IntersectionObserver per card — each card starts/stops its own
// timers only while scrolled into view.
function useInView<T extends HTMLElement>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.25 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, inView];
}

// Cycles 0..steps-1 on a fixed interval while `active`; holds its last
// value (and simply stops advancing) once `active` goes false.
function useCycle(steps: number, intervalMs: number, active: boolean): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setStep(s => (s + 1) % steps), intervalMs);
    return () => clearInterval(id);
  }, [active, steps, intervalMs]);
  return step;
}

// Small scale-pop transform, re-triggered whenever `dep` changes while active.
function usePop(dep: unknown, active: boolean): React.CSSProperties {
  const [pop, setPop] = useState(false);
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return; }
    if (!active) return;
    setPop(true);
    const t = setTimeout(() => setPop(false), 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep, active]);
  return { transform: pop ? 'scale(1.16)' : 'scale(1)', transition: 'transform 200ms ease-out' };
}

// ── Small shared bits ───────────────────────────────────────────────────

function ExampleTag() {
  return (
    <span className="inline-flex items-center px-1.5 py-[2px] rounded-md border border-dashed border-line text-muted font-body font-semibold text-[8.5px] tracking-wide uppercase flex-shrink-0">
      Example
    </span>
  );
}

function CardShell({
  chips,
  title,
  desc,
  footer,
  rootRef,
  children,
}: {
  chips: EdgeChipVariant[];
  title: string;
  desc: string;
  footer?: ReactNode;
  rootRef: RefObject<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      ref={rootRef}
      className="bg-surface rounded-card shadow-card border border-line p-5 flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {chips.map(c => <EdgeChip key={c} variant={c} />)}
        </div>
        <ExampleTag />
      </div>
      <div>
        <h3 className="font-display font-semibold text-[15px] text-ink leading-snug mb-1">
          {title}
        </h3>
        <p className="font-body text-[13px] text-ink-2 leading-relaxed">
          {desc}
        </p>
      </div>
      <div className="relative h-[176px] rounded-[12px] bg-bg-soft/60 border border-line overflow-hidden">
        {children}
      </div>
      {footer}
    </div>
  );
}

// ── Shared animated cursor (Prediction / Funding / Liquidity cards) ─────
// A single pointer that glides to measured target elements and fires a
// click-ripple on arrival. Positions are measured off real DOM rects so
// the cursor lines up with its target at any card width (mobile included).

type Point = { x: number; y: number };

// Re-measures target centers (relative to `frameRef`) plus a "home" resting
// corner, on every render and on window resize — guarded so it only calls
// setState when a value actually changed, to avoid a render loop.
function useCursorPoints(
  frameRef: RefObject<HTMLElement>,
  targetRefs: RefObject<HTMLElement>[],
): { home: Point; points: Point[] } {
  const [state, setState] = useState<{ home: Point; points: Point[] }>({
    home: { x: 0, y: 0 },
    points: targetRefs.map(() => ({ x: 0, y: 0 })),
  });
  useEffect(() => {
    function measure() {
      const frame = frameRef.current;
      if (!frame) return;
      const frameRect = frame.getBoundingClientRect();
      const points = targetRefs.map(r => {
        const el = r.current;
        if (!el) return { x: 0, y: 0 };
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left - frameRect.left + rect.width / 2,
          y: rect.top - frameRect.top + rect.height / 2,
        };
      });
      const home = { x: frameRect.width - 18, y: frameRect.height - 16 };
      setState(prev => {
        const same =
          prev.home.x === home.x &&
          prev.home.y === home.y &&
          prev.points.length === points.length &&
          prev.points.every((p, i) => p.x === points[i].x && p.y === points[i].y);
        return same ? prev : { home, points };
      });
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });
  return state;
}

// One-shot expanding ring, re-triggered by remounting with a fresh `key`.
function ClickRipple() {
  const [grow, setGrow] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrow(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <span
      aria-hidden
      className={`absolute top-0 left-0 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-mint pointer-events-none transition-all duration-500 ease-out ${
        grow ? 'w-7 h-7 opacity-0' : 'w-1.5 h-1.5 opacity-90'
      }`}
    />
  );
}

function AnimatedCursor({
  point, visible, clickKey,
}: {
  point: Point;
  visible: boolean;
  clickKey: number | null;
}) {
  return (
    <div
      className="absolute top-0 left-0 z-20 pointer-events-none"
      style={{
        transform: `translate(${point.x - 2}px, ${point.y - 2}px)`,
        opacity: visible ? 1 : 0,
        transition: 'transform 700ms ease-out, opacity 300ms ease-out',
      }}
      aria-hidden
    >
      <svg width="16" height="18" viewBox="0 0 16 18" className="drop-shadow-md">
        <path
          d="M1 1 L1 14.5 L4.8 11.2 L7 16.5 L9.3 15.5 L7.1 10.3 L12 10.3 Z"
          fill="#0B1A15"
          stroke="#F4FBF8"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
      {clickKey !== null && <ClickRipple key={clickKey} />}
    </div>
  );
}

// ── 1. Prediction arbitrage (cashable) ──────────────────────────────────

type PredictionState = {
  kalshiFilled: boolean;
  polyFilled: boolean;
  done: boolean;
  cursorVisible: boolean;
  cursorTarget: 0 | 1; // 0 = Kalshi pill, 1 = Polymarket pill
  clickKey: number | null;
};

const PREDICTION_IDLE: PredictionState = {
  kalshiFilled: false, polyFilled: false, done: false,
  cursorVisible: false, cursorTarget: 0, clickKey: null,
};
const PREDICTION_DONE: PredictionState = {
  kalshiFilled: true, polyFilled: true, done: true,
  cursorVisible: false, cursorTarget: 1, clickKey: null,
};

// Custom variable-length phase timer: cursor travels to the Kalshi pill and
// clicks it, travels to the Polymarket pill and clicks it, then the result
// bar settles — each stage holds a different duration, so the fixed-interval
// useCycle() above can't express it.
function usePredictionAnimation(active: boolean): PredictionState {
  const [state, setState] = useState<PredictionState>(PREDICTION_IDLE);
  const clickRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    function runCycle() {
      timers.forEach(clearTimeout);
      timers = [];
      setState(PREDICTION_IDLE);
      timers.push(setTimeout(() => setState(s => ({ ...s, cursorVisible: true, cursorTarget: 0 })), 300));
      timers.push(setTimeout(() => {
        clickRef.current += 1;
        setState(s => ({ ...s, kalshiFilled: true, cursorTarget: 1, clickKey: clickRef.current }));
      }, 1000));
      timers.push(setTimeout(() => {
        clickRef.current += 1;
        setState(s => ({ ...s, polyFilled: true, clickKey: clickRef.current }));
      }, 1700));
      timers.push(setTimeout(() => setState(s => ({ ...s, cursorVisible: false, done: true })), 2100));
    }
    runCycle();
    const loopId = setInterval(runCycle, 6000);
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(loopId);
    };
  }, [active]);
  return state;
}

function PredictionArbCard({ reducedMotion }: { reducedMotion: boolean }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const active = inView && !reducedMotion;
  const liveState = usePredictionAnimation(active);
  const { kalshiFilled, polyFilled, done, cursorVisible, cursorTarget, clickKey } =
    reducedMotion ? PREDICTION_DONE : liveState;

  const frameRef = useRef<HTMLDivElement>(null);
  const kalshiPillRef = useRef<HTMLDivElement>(null);
  const polyPillRef = useRef<HTMLDivElement>(null);
  const { home, points } = useCursorPoints(frameRef, [kalshiPillRef, polyPillRef]);
  const cursorPoint = cursorVisible ? points[cursorTarget] : home;

  return (
    <CardShell
      chips={['cashable']}
      title="Prediction arbitrage"
      desc="Same-outcome contracts priced differently on Kalshi and Polymarket. Both legs checked, capacity-confirmed. A green badge means you can actually fill it."
      rootRef={ref}
    >
      <div ref={frameRef} className="relative w-full h-full flex flex-col items-center justify-center gap-2.5 px-3">
        <div className="flex items-center gap-2">
          {/* Kalshi */}
          <div
            className={`px-2 py-2 rounded-lg border-2 text-center w-[100px] transition-colors duration-300 ${
              kalshiFilled ? 'bg-[#ecfdf5] border-[#10b981]' : 'bg-surface border-line'
            }`}
          >
            <div className="flex items-center justify-center gap-1 mb-1">
              <span className="w-3.5 h-3.5 rounded-full bg-[#10b981] text-white font-body font-bold text-[7.5px] flex items-center justify-center flex-shrink-0" aria-hidden>
                K
              </span>
              <span className="text-[8px] text-muted uppercase tracking-wide">Kalshi</span>
            </div>
            <div className="font-display font-bold text-ink text-sm">58&cent;</div>
            <div
              ref={kalshiPillRef}
              className={`mt-1 px-1.5 py-[2px] rounded-sm font-body font-semibold text-[8.5px] transition-colors duration-300 ${
                kalshiFilled ? 'bg-[#10b981] text-white' : 'text-muted'
              }`}
            >
              {kalshiFilled ? <>&#10003; BUY</> : 'buy side'}
            </div>
          </div>

          {/* Center: gap / value / arrow */}
          <div className="flex flex-col items-center gap-0.5 flex-shrink-0 w-[36px]">
            <span className="text-[8px] uppercase tracking-wide text-muted">gap</span>
            <span
              className={`font-display font-bold text-base leading-none transition-all duration-300 ${
                done ? 'text-[#047857] scale-125' : 'text-ink-2 scale-100'
              }`}
            >
              4&cent;
            </span>
            <span className={`text-sm leading-none transition-colors duration-300 ${polyFilled ? 'text-mint-deep' : 'text-muted'}`} aria-hidden>
              &rarr;
            </span>
          </div>

          {/* Polymarket */}
          <div
            className={`px-2 py-2 rounded-lg border-2 text-center w-[100px] transition-colors duration-300 ${
              polyFilled ? 'bg-[#eef4ff] border-[#1652f0]' : 'bg-surface border-line'
            }`}
          >
            <div className="flex items-center justify-center gap-1 mb-1">
              <span className="w-3.5 h-3.5 rounded-full bg-[#1652f0] text-white font-body font-bold text-[7.5px] flex items-center justify-center flex-shrink-0" aria-hidden>
                P
              </span>
              <span className="text-[8px] text-muted uppercase tracking-wide">Polymarket</span>
            </div>
            <div className="font-display font-bold text-ink text-sm">62&cent;</div>
            <div
              ref={polyPillRef}
              className={`mt-1 px-1.5 py-[2px] rounded-sm font-body font-semibold text-[8.5px] transition-colors duration-300 ${
                polyFilled ? 'bg-[#1652f0] text-white' : 'text-muted'
              }`}
            >
              {polyFilled ? <>&#10003; SELL</> : 'sell side'}
            </div>
          </div>
        </div>

        {/* Result bar */}
        <div
          className={`w-full max-w-[264px] px-2.5 py-1.5 rounded-md border flex items-center justify-between gap-2 transition-colors duration-300 ${
            done ? 'bg-[#ecfdf5] border-[#d1fae5]' : 'bg-surface border-line'
          }`}
        >
          <span className={`font-body text-[10.5px] truncate ${done ? 'font-bold text-[#047857]' : 'text-muted'}`}>
            {done ? <>&#10003; cashable &mdash; you locked the gap</> : 'checking both legs…'}
          </span>
          <span className={`font-body font-bold text-[10.5px] flex-shrink-0 ${done ? 'text-[#047857]' : 'text-muted'}`}>
            +$4.00
          </span>
        </div>

        {!reducedMotion && <AnimatedCursor point={cursorPoint} visible={cursorVisible} clickKey={clickKey} />}
      </div>
    </CardShell>
  );
}

// ── 2. Funding spreads (cashable) ───────────────────────────────────────

const FUNDING_LABELS = ['0h', 'after 8h', 'after 16h', 'after 24h'];

type FundingState = {
  longOpen: boolean;
  shortOpen: boolean;
  step: number; // 0..3 -> FUNDING_LABELS index, only counts once both legs are open
  cursorVisible: boolean;
  cursorTarget: 0 | 1; // 0 = LONG spot tile, 1 = SHORT perp tile
  clickKey: number | null;
};

const FUNDING_IDLE: FundingState = {
  longOpen: false, shortOpen: false, step: 0,
  cursorVisible: false, cursorTarget: 0, clickKey: null,
};
const FUNDING_DONE: FundingState = {
  longOpen: true, shortOpen: true, step: 3,
  cursorVisible: false, cursorTarget: 1, clickKey: null,
};

// Custom timer: cursor opens the long leg, opens the short leg, then the
// 0h/8h/16h/24h timeline steps while the funding-collected counter climbs.
function useFundingAnimation(active: boolean): FundingState {
  const [state, setState] = useState<FundingState>(FUNDING_IDLE);
  const clickRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    function runCycle() {
      timers.forEach(clearTimeout);
      timers = [];
      setState(FUNDING_IDLE);
      timers.push(setTimeout(() => setState(s => ({ ...s, cursorVisible: true, cursorTarget: 0 })), 300));
      timers.push(setTimeout(() => {
        clickRef.current += 1;
        setState(s => ({ ...s, longOpen: true, cursorTarget: 1, clickKey: clickRef.current }));
      }, 1000));
      timers.push(setTimeout(() => {
        clickRef.current += 1;
        setState(s => ({ ...s, shortOpen: true, clickKey: clickRef.current }));
      }, 1700));
      timers.push(setTimeout(() => setState(s => ({ ...s, cursorVisible: false })), 2100));
      timers.push(setTimeout(() => setState(s => ({ ...s, step: 1 })), 3200));
      timers.push(setTimeout(() => setState(s => ({ ...s, step: 2 })), 4300));
      timers.push(setTimeout(() => setState(s => ({ ...s, step: 3 })), 5400));
    }
    runCycle();
    const loopId = setInterval(runCycle, 6600);
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(loopId);
    };
  }, [active]);
  return state;
}

function FundingSpreadCard({ reducedMotion }: { reducedMotion: boolean }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const active = inView && !reducedMotion;
  const liveState = useFundingAnimation(active);
  const { longOpen, shortOpen, step, cursorVisible, cursorTarget, clickKey } =
    reducedMotion ? FUNDING_DONE : liveState;
  const value = (step * 0.12).toFixed(2);
  const popStyle = usePop(step, active);

  const frameRef = useRef<HTMLDivElement>(null);
  const longRef = useRef<HTMLSpanElement>(null);
  const shortRef = useRef<HTMLSpanElement>(null);
  const { home, points } = useCursorPoints(frameRef, [longRef, shortRef]);
  const cursorPoint = cursorVisible ? points[cursorTarget] : home;

  return (
    <CardShell
      chips={['cashable']}
      title="Funding spreads"
      desc="Earn perpetual funding — the recurring payment between long and short positions in crypto futures — by holding long spot and short perp, or the reverse. Rates reset every 8 hours; no lockup, but no guarantee of tomorrow's rate."
      rootRef={ref}
    >
      <div ref={frameRef} className="relative w-full h-full flex flex-col items-center justify-center gap-3 px-4">
        <div className="flex items-center gap-2">
          <span
            ref={longRef}
            className={`px-2 py-1 rounded-md font-body font-semibold text-[10px] transition-colors duration-300 ${
              longOpen ? 'bg-[#10b981] text-white' : 'bg-mint-tint text-mint-deep'
            }`}
          >
            {longOpen ? <>&#10003; open</> : 'LONG spot'}
          </span>
          <span
            ref={shortRef}
            className={`px-2 py-1 rounded-md font-body font-semibold text-[10px] transition-colors duration-300 ${
              shortOpen ? 'bg-[#dc2626] text-white' : 'bg-coral-tint text-coral-ink'
            }`}
          >
            {shortOpen ? <>&#10003; open</> : 'SHORT perp'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {FUNDING_LABELS.map((label, i) => (
            <div key={label} className="flex flex-col items-center gap-1">
              <span
                className={`w-2 h-2 rounded-full transition-colors duration-300 ${
                  longOpen && shortOpen && i <= step ? 'bg-mint' : 'bg-line'
                }`}
                aria-hidden
              />
              <span className="text-[7.5px] text-muted whitespace-nowrap">{label}</span>
            </div>
          ))}
        </div>
        <div>
          <div
            className="font-display font-bold text-mint-deep text-2xl text-center"
            style={popStyle}
          >
            ${value}
          </div>
          <p className="text-[10px] text-muted text-center mt-0.5">$ funding collected</p>
        </div>

        {!reducedMotion && <AnimatedCursor point={cursorPoint} visible={cursorVisible} clickKey={clickKey} />}
      </div>
    </CardShell>
  );
}

// ── 3. Cash & carry (cashable) ──────────────────────────────────────────

function CarryCard({ reducedMotion }: { reducedMotion: boolean }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const active = inView && !reducedMotion;
  const [t, setT] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const duration = 3000;
    const tick = (ts: number) => {
      if (startRef.current === null) startRef.current = ts;
      const elapsed = (ts - startRef.current) % duration;
      setT(elapsed / duration);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      startRef.current = null;
    };
  }, [active]);

  const tt = reducedMotion ? 1 : t;
  const x0 = 15;
  const x1 = 245;
  const spotY = 72;
  const futureY0 = 26;
  const markerX = x0 + tt * (x1 - x0);
  const futureYAtMarker = futureY0 + tt * (spotY - futureY0);
  const basisPct = (1.7 * (1 - tt)).toFixed(1);

  return (
    <CardShell
      chips={['cashable']}
      title="Cash & carry"
      desc="Lock in the basis — the price gap between spot and a dated futures contract. Yield is fixed at expiry — most contracts are coin-margined, so the USD return drifts with spot price."
      rootRef={ref}
    >
      <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 px-3">
        <svg width="100%" height="86" viewBox="0 0 260 100" className="overflow-visible" role="img" aria-label="Spot and future price convergence">
          <line x1={x0} y1={spotY} x2={x1} y2={spotY} stroke="#0B1A15" strokeWidth={2} />
          <line x1={x0} y1={futureY0} x2={x1} y2={spotY} stroke="#0FBE82" strokeWidth={2} />
          <line
            x1={markerX} y1={futureYAtMarker} x2={markerX} y2={spotY}
            stroke="#6C7E78" strokeWidth={1} strokeDasharray="3 3"
          />
          <circle cx={markerX} cy={futureYAtMarker} r={3.5} fill="#0FBE82" />
          <text x={x1 - 26} y={spotY + 14} fontSize="8" fill="#6C7E78">spot</text>
          <text x={x0} y={futureY0 - 6} fontSize="8" fill="#0A9D6B">future</text>
        </svg>
        <p className="font-body text-[11px] text-ink-2">
          basis <span className="font-semibold text-mint-deep">{basisPct}%</span>
        </p>
        <p className="font-body text-[10px] text-muted text-center leading-snug">
          gap closes at expiry &rarr; yield fixed
        </p>
      </div>
    </CardShell>
  );
}

// ── 4. Liquidity rewards (cashable) ─────────────────────────────────────

type BookRowStatus = 'none' | 'placing' | 'resting';

const ASK_LEVELS = [
  { price: '65¢', sizeLabel: '4.2k', width: 82 },
  { price: '64¢', sizeLabel: '2.6k', width: 46 },
  { price: '63¢', sizeLabel: '1.5k', width: 22 }, // maker ask rests here
] as const;

const BID_LEVELS = [
  { price: '61¢', sizeLabel: '3.1k', width: 58 }, // maker bid rests here
  { price: '60¢', sizeLabel: '2.2k', width: 38 },
  { price: '59¢', sizeLabel: '3.8k', width: 73 },
] as const;

function BookLevel({
  price, sizeLabel, width, tone, isMaker, status, pulse,
}: {
  price: string; sizeLabel: string; width: number; tone: 'ask' | 'bid';
  isMaker: boolean; status: BookRowStatus; pulse: boolean;
}) {
  const isAsk = tone === 'ask';
  const mine = isMaker && status !== 'none';
  const rowBg = isAsk ? 'bg-[#fef2f2]' : 'bg-[#ecfdf5]';
  const barBg = isAsk ? 'bg-[#ef4444]/20' : 'bg-[#10b981]/20';
  const text = isAsk ? 'text-[#ef4444]' : 'text-[#10b981]';
  const ring = isAsk
    ? 'border-[#ef4444] shadow-[0_0_0_3px_rgba(239,68,68,0.15)]'
    : 'border-[#10b981] shadow-[0_0_0_3px_rgba(16,185,129,0.15)]';
  return (
    <div
      className={`relative flex items-center justify-between px-2 py-[1.5px] text-[9.5px] leading-tight rounded-sm overflow-hidden border-2 transition-all duration-300 ${rowBg} ${
        mine ? ring : 'border-transparent'
      }`}
    >
      <span className={`absolute inset-y-0 left-0 ${barBg}`} style={{ width: `${width}%` }} aria-hidden />
      <span className={`relative font-body font-bold tabular-nums ${text}`}>{price}</span>
      {mine && (
        <span
          className={`relative font-body font-extrabold text-[7.5px] uppercase tracking-wide ${text} ${
            status === 'resting' && pulse ? 'animate-pulse' : ''
          }`}
        >
          you
        </span>
      )}
      <span className={`relative font-body text-[8.5px] ${mine ? `font-bold ${text}` : 'text-muted'}`}>
        {mine ? 'your order' : sizeLabel}
      </span>
    </div>
  );
}

// Local cursor for this card only — deliberately not the shared AnimatedCursor
// (that one is reused by the Prediction/Funding cards; swapping its look here
// would change those too). Adds a brief scale-down "click" on top of the
// shared ring-pulse pattern.
function LiquidityCursor({
  point, visible, clickKey,
}: {
  point: Point;
  visible: boolean;
  clickKey: number | null;
}) {
  const [clicking, setClicking] = useState(false);
  useEffect(() => {
    if (clickKey === null) return;
    setClicking(true);
    const t = setTimeout(() => setClicking(false), 160);
    return () => clearTimeout(t);
  }, [clickKey]);

  return (
    <div
      className="absolute top-0 left-0 z-20 pointer-events-none"
      style={{
        transform: `translate(${point.x - 3}px, ${point.y - 3}px)`,
        opacity: visible ? 1 : 0,
        transition: 'transform 500ms ease, opacity 300ms ease',
      }}
      aria-hidden
    >
      <div style={{ transform: clicking ? 'scale(0.85)' : 'scale(1)', transition: 'transform 160ms ease-out' }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M5 3l14 8-6 1.5L10 20 5 3z" fill="#0f172a" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </div>
      {clickKey !== null && <ClickRipple key={clickKey} />}
    </div>
  );
}

const REWARD_STEPS = [0.00, 0.18, 0.36, 0.54, 0.72, 0.90, 1.08, 1.24];

type LiquidityState = {
  askStatus: BookRowStatus;
  bidStatus: BookRowStatus;
  rewardStep: number; // index into REWARD_STEPS
  cursorVisible: boolean;
  cursorTarget: 0 | 1; // 0 = ask row, 1 = bid row
  clickKey: number | null;
};

const LIQUIDITY_IDLE: LiquidityState = {
  askStatus: 'none', bidStatus: 'none', rewardStep: 0,
  cursorVisible: false, cursorTarget: 0, clickKey: null,
};
const LIQUIDITY_DONE: LiquidityState = {
  askStatus: 'resting', bidStatus: 'resting', rewardStep: REWARD_STEPS.length - 1,
  cursorVisible: false, cursorTarget: 1, clickKey: null,
};

// Custom timer: cursor places the ask, then the bid, then the rewards
// counter ticks up while both orders sit resting (never filled).
function useLiquidityAnimation(active: boolean): LiquidityState {
  const [state, setState] = useState<LiquidityState>(LIQUIDITY_IDLE);
  const clickRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    function runCycle() {
      timers.forEach(clearTimeout);
      timers = [];
      setState(LIQUIDITY_IDLE);
      timers.push(setTimeout(() => setState(s => ({ ...s, cursorVisible: true, cursorTarget: 0 })), 300));
      timers.push(setTimeout(() => {
        clickRef.current += 1;
        setState(s => ({ ...s, askStatus: 'placing', clickKey: clickRef.current }));
      }, 1000));
      timers.push(setTimeout(() => setState(s => ({ ...s, askStatus: 'resting', cursorTarget: 1 })), 1500));
      timers.push(setTimeout(() => {
        clickRef.current += 1;
        setState(s => ({ ...s, bidStatus: 'placing', clickKey: clickRef.current }));
      }, 2500));
      timers.push(setTimeout(() => setState(s => ({ ...s, bidStatus: 'resting', cursorVisible: false })), 3000));
      REWARD_STEPS.forEach((_, i) => {
        if (i === 0) return;
        timers.push(setTimeout(() => setState(s => ({ ...s, rewardStep: i })), 3300 + (i - 1) * 500));
      });
    }
    runCycle();
    const loopId = setInterval(runCycle, 7900);
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(loopId);
    };
  }, [active]);
  return state;
}

function LiquidityRewardsCard({ reducedMotion }: { reducedMotion: boolean }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const active = inView && !reducedMotion;
  const liveState = useLiquidityAnimation(active);
  const { askStatus, bidStatus, rewardStep, cursorVisible, cursorTarget, clickKey } =
    reducedMotion ? LIQUIDITY_DONE : liveState;
  const reward = REWARD_STEPS[rewardStep].toFixed(2);
  const popStyle = usePop(rewardStep, active);

  const frameRef = useRef<HTMLDivElement>(null);
  const askRowRef = useRef<HTMLDivElement>(null);
  const bidRowRef = useRef<HTMLDivElement>(null);
  const { home, points } = useCursorPoints(frameRef, [askRowRef, bidRowRef]);
  // Cursor enters from the top-right corner (shared hook's `home` rests
  // bottom-right for the other cards) — reuse its measured x, override y.
  const homeTopRight: Point = { x: home.x, y: 14 };
  const cursorPoint = cursorVisible ? points[cursorTarget] : homeTopRight;

  return (
    <CardShell
      chips={['cashable']}
      title="Liquidity rewards"
      desc="Earn real maker rewards for providing liquidity on Polymarket and Kalshi. We show net estimated reward/day and flag any program rate we can't confirm."
      rootRef={ref}
    >
      <div ref={frameRef} className="relative w-full h-full flex flex-col justify-center gap-[1px] px-3 py-1">
        <div className="flex flex-col gap-[1px]">
          <p className="pl-11 font-body font-bold text-[7px] uppercase tracking-wide leading-tight text-[#ef4444]">
            Sellers · asks
          </p>
          {ASK_LEVELS.map((lvl, i) => {
            const isMakerRow = i === ASK_LEVELS.length - 1;
            return (
              <div key={lvl.price} ref={isMakerRow ? askRowRef : undefined}>
                <BookLevel
                  price={lvl.price}
                  sizeLabel={lvl.sizeLabel}
                  width={lvl.width}
                  tone="ask"
                  isMaker={isMakerRow}
                  status={isMakerRow ? askStatus : 'none'}
                  pulse={!reducedMotion}
                />
              </div>
            );
          })}
        </div>

        <div className="relative flex items-center" aria-hidden>
          <div className="flex-1 border-t border-dashed border-line" />
          <span className="px-1.5 font-body text-[6.5px] leading-tight text-muted whitespace-nowrap">
            mid 62¢ · place orders inside this gap
          </span>
          <div className="flex-1 border-t border-dashed border-line" />
        </div>

        <div className="flex flex-col gap-[1px]">
          <p className="pl-11 font-body font-bold text-[7px] uppercase tracking-wide leading-tight text-[#10b981]">
            Buyers · bids
          </p>
          {BID_LEVELS.map((lvl, i) => {
            const isMakerRow = i === 0;
            return (
              <div key={lvl.price} ref={isMakerRow ? bidRowRef : undefined}>
                <BookLevel
                  price={lvl.price}
                  sizeLabel={lvl.sizeLabel}
                  width={lvl.width}
                  tone="bid"
                  isMaker={isMakerRow}
                  status={isMakerRow ? bidStatus : 'none'}
                  pulse={!reducedMotion}
                />
              </div>
            );
          })}
        </div>

        <div className="flex items-baseline justify-center gap-1.5" style={popStyle}>
          <span className="font-serif font-bold text-[#10b981] text-[15px] leading-none">
            +${reward}
          </span>
          <span className="font-body text-[8.5px] leading-none text-muted">maker rewards</span>
        </div>

        {!reducedMotion && <LiquidityCursor point={cursorPoint} visible={cursorVisible} clickKey={clickKey} />}
      </div>
    </CardShell>
  );
}

// ── 5. Top traders (signal) ─────────────────────────────────────────────

const TRADERS = [
  { rank: 1, medal: '🥇', addr: '0x8f3a…c12', pnl: '+$4,210', win: '71%' },
  { rank: 2, medal: '',   addr: '0x2c91…9ab', pnl: '+$2,880', win: '64%' },
  { rank: 3, medal: '',   addr: '0x91be…7f4', pnl: '+$1,940', win: '58%' },
] as const;

function Sparkline() {
  return (
    <svg width="56" height="20" viewBox="0 0 56 20" className="flex-shrink-0" role="img" aria-label="Upward equity curve">
      <polyline
        points="0,18 10,15 18,16 26,10 34,11 42,5 56,2"
        fill="none"
        stroke="#0A9D6B"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TopTradersCard({ reducedMotion }: { reducedMotion: boolean }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const active = inView && !reducedMotion;
  const liveStep = useCycle(4, 1100, active); // 4.4s loop
  const s = reducedMotion ? 3 : liveStep;
  const listVisible = s >= 1;
  const topHighlighted = s >= 2;
  const expanded = s >= 3;

  return (
    <CardShell
      chips={['signal', 'copy_trader']}
      title="Top traders"
      desc="Every public Polymarket wallet ranked by true win rate, with statistical confidence. Open a name to see its equity curve, then copy the ones worth following."
      rootRef={ref}
    >
      <div className="w-full h-full flex flex-col gap-2 px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="px-2 py-[3px] rounded-md bg-[#EEF1FF] text-[#3B4FD0] font-body font-semibold text-[9.5px]">
            Polymarket
          </span>
          <span className="px-2 py-[3px] rounded-md text-muted font-body font-semibold text-[9.5px] opacity-50">
            Kalshi
          </span>
        </div>
        <div className="flex flex-col gap-1 flex-1 justify-center">
          {TRADERS.map(t => (
            <div
              key={t.rank}
              className={`flex items-center justify-between gap-2 px-2 py-1 rounded-md transition-all duration-300 ${
                listVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'
              } ${t.rank === 1 && topHighlighted ? 'bg-mint-tint' : ''}`}
            >
              <span className="font-body text-[10px] text-ink-2 flex items-center gap-1 min-w-0">
                {t.rank === 1 && <span aria-hidden>{t.medal}</span>}
                <span className="truncate">{t.addr}</span>
              </span>
              {t.rank === 1 && expanded ? (
                <Sparkline />
              ) : (
                <span className="font-body font-semibold text-[10px] text-mint-deep flex-shrink-0">
                  {t.pnl} <span className="text-muted font-normal">· {t.win}</span>
                </span>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          tabIndex={-1}
          className={`self-start px-2.5 py-1 rounded-md bg-mint-deep text-white font-body font-semibold text-[9.5px] transition-opacity duration-300 ${
            expanded ? 'opacity-100' : 'opacity-0'
          }`}
        >
          + Copy trader
        </button>
      </div>
    </CardShell>
  );
}

// ── 6. Sports arbitrage (signal) ────────────────────────────────────────

const SPORTS_OUTCOMES = [
  { label: 'Team X wins', book: 'Book A', odd: '2.10' },
  { label: 'Draw',        book: 'Book B', odd: '4.20' },
  { label: 'Team Y wins', book: 'Book C', odd: '3.40' },
] as const;

function SportsArbCard({ reducedMotion }: { reducedMotion: boolean }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const active = inView && !reducedMotion;
  const liveStep = useCycle(5, 700, active); // 3.5s loop
  const s = reducedMotion ? 4 : liveStep;
  const checkedIndex = s >= 1 && s <= 3 ? s - 1 : -1;
  const profitVisible = s >= 4;

  return (
    <CardShell
      chips={['signal']}
      title="Sports edges"
      desc="Lock a margin when the same outcome is priced differently across 40+ sportsbooks. Soft-book and cross-jurisdiction legs are flagged so you only act on truly takeable ones."
      rootRef={ref}
      footer={
        <div className="flex items-center gap-1.5 pt-0.5">
          <EdgeChip variant="signal" />
          <span className="font-body text-[10px] text-muted">verify each leg before acting</span>
        </div>
      }
    >
      <div className="w-full h-full flex flex-col gap-1.5 px-3 py-2.5">
        <p className="font-body text-[10px] text-ink-2 font-medium text-center">Team X vs Team Y</p>
        <div className="flex flex-col gap-1 flex-1 justify-center">
          {SPORTS_OUTCOMES.map((o, i) => (
            <div
              key={o.label}
              className={`flex items-center justify-between px-2 py-1 rounded-md border transition-colors duration-300 ${
                checkedIndex === i ? 'border-mint bg-mint-tint' : 'border-line bg-surface'
              }`}
            >
              <span className="font-body text-[9.5px] text-ink-2 truncate">
                {o.label} <span className="text-muted">· {o.book}</span>
              </span>
              <span className="flex items-center gap-1 flex-shrink-0">
                <span className="font-body font-semibold text-[10px] text-ink">{o.odd}</span>
                <span className={`text-[10px] text-mint-deep transition-opacity duration-200 ${checkedIndex === i ? 'opacity-100' : 'opacity-0'}`} aria-hidden>
                  &#10003;
                </span>
              </span>
            </div>
          ))}
        </div>
        <p
          className={`text-center font-body font-semibold text-[11px] px-2 py-1 rounded-md bg-mint-tint text-mint-deep transition-opacity duration-300 ${
            profitVisible ? 'opacity-100' : 'opacity-0'
          }`}
        >
          profit either way +$3.80
        </p>
      </div>
    </CardShell>
  );
}

// ── Section ──────────────────────────────────────────────────────────────

export default function AnimatedStrategies() {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <section
      id="what-it-finds"
      className="border-t border-line bg-bg-soft/50"
      aria-labelledby="whats-inside-heading"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
        <div className="mb-10">
          <Eyebrow className="mb-2">More than arbitrage</Eyebrow>
          <SectionHeading id="whats-inside-heading" className="text-2xl sm:text-3xl">
            Six ways to find your edge
          </SectionHeading>
          <p className="font-body text-sm text-ink-2 mt-2 max-w-2xl">
            Whether you came from crypto or traditional finance, every edge below &mdash; across
            prediction markets, crypto, and sports &mdash; is scored the same honest way.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <PredictionArbCard reducedMotion={reducedMotion} />
          <FundingSpreadCard reducedMotion={reducedMotion} />
          <CarryCard reducedMotion={reducedMotion} />
          <LiquidityRewardsCard reducedMotion={reducedMotion} />
          <TopTradersCard reducedMotion={reducedMotion} />
          <SportsArbCard reducedMotion={reducedMotion} />
        </div>

        <p className="font-body text-[11px] text-muted mt-6 text-center sm:text-left max-w-2xl">
          Animations and numbers are illustrative examples. Real, executable values live in the dashboard.
        </p>
      </div>
    </section>
  );
}
