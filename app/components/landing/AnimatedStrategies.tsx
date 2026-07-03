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

// ── 1. Prediction arbitrage (cashable) ──────────────────────────────────

type PredictionPhase = 'idle' | 'buy' | 'sell' | 'done';

// Custom variable-length phase timer (idle/buy/sell hold briefly, done holds
// longer) — the fixed-interval useCycle() above can't express uneven step
// durations, so this schedules its own timeouts and re-arms them every loop.
function usePredictionPhase(active: boolean): PredictionPhase {
  const [phase, setPhase] = useState<PredictionPhase>('idle');
  useEffect(() => {
    if (!active) return;
    let cycleTimers: ReturnType<typeof setTimeout>[] = [];
    function runCycle() {
      cycleTimers.forEach(clearTimeout);
      cycleTimers = [];
      setPhase('idle');
      cycleTimers.push(setTimeout(() => setPhase('buy'), 700));
      cycleTimers.push(setTimeout(() => setPhase('sell'), 1700));
      cycleTimers.push(setTimeout(() => setPhase('done'), 2700));
    }
    runCycle();
    const loopId = setInterval(runCycle, 5200);
    return () => {
      cycleTimers.forEach(clearTimeout);
      clearInterval(loopId);
    };
  }, [active]);
  return phase;
}

function PredictionArbCard({ reducedMotion }: { reducedMotion: boolean }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const active = inView && !reducedMotion;
  const livePhase = usePredictionPhase(active);
  const phase = reducedMotion ? 'done' : livePhase;

  const kalshiFilled = phase === 'buy' || phase === 'sell' || phase === 'done';
  const polyFilled   = phase === 'sell' || phase === 'done';
  const done         = phase === 'done';

  return (
    <CardShell
      chips={['cashable']}
      title="Prediction arbitrage"
      desc="Same-outcome contracts priced differently on Kalshi and Polymarket. Both legs checked, capacity-confirmed. A green badge means you can actually fill it."
      rootRef={ref}
    >
      <div className="w-full h-full flex flex-col items-center justify-center gap-2.5 px-3">
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
              className={`mt-1 px-1.5 py-[2px] rounded-sm font-body font-semibold text-[8.5px] transition-colors duration-300 ${
                kalshiFilled ? 'bg-[#10b981] text-white' : 'text-muted'
              }`}
            >
              {kalshiFilled ? <>&darr; BUY</> : 'buy side'}
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
              className={`mt-1 px-1.5 py-[2px] rounded-sm font-body font-semibold text-[8.5px] transition-colors duration-300 ${
                polyFilled ? 'bg-[#1652f0] text-white' : 'text-muted'
              }`}
            >
              {polyFilled ? <>&uarr; SELL</> : 'sell side'}
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
            {done ? <>&#10003; cashable &mdash; you can fill it</> : 'checking both legs…'}
          </span>
          <span className={`font-body font-bold text-[10.5px] flex-shrink-0 ${done ? 'text-[#047857]' : 'text-muted'}`}>
            +4&cent;
          </span>
        </div>
      </div>
    </CardShell>
  );
}

// ── 2. Funding spreads (cashable) ───────────────────────────────────────

const FUNDING_LABELS = ['0h', 'after 8h', 'after 16h', 'after 24h'];

function FundingSpreadCard({ reducedMotion }: { reducedMotion: boolean }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const active = inView && !reducedMotion;
  const liveStep = useCycle(4, 1600, active);
  const s = reducedMotion ? 3 : liveStep;
  const value = (s * 0.12).toFixed(2);
  const popStyle = usePop(s, active);

  return (
    <CardShell
      chips={['cashable']}
      title="Funding spreads"
      desc="Earn perpetual funding — the recurring payment between long and short positions in crypto futures — by holding long spot and short perp, or the reverse. Rates reset every 8 hours; no lockup, but no guarantee of tomorrow's rate."
      rootRef={ref}
    >
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 px-4">
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded-md bg-mint-tint text-mint-deep font-body font-semibold text-[10px]">
            LONG spot
          </span>
          <span className="px-2 py-1 rounded-md bg-coral-tint text-coral-ink font-body font-semibold text-[10px]">
            SHORT perp
          </span>
        </div>
        <div className="flex items-center gap-3">
          {FUNDING_LABELS.map((label, i) => (
            <div key={label} className="flex flex-col items-center gap-1">
              <span
                className={`w-2 h-2 rounded-full transition-colors duration-300 ${i <= s ? 'bg-mint' : 'bg-line'}`}
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
          <p className="text-[10px] text-muted text-center mt-0.5">funding collected</p>
        </div>
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

function BookRow({
  price, size, tone, highlighted,
}: {
  price: string; size: number; tone: 'ask' | 'bid'; highlighted: boolean;
}) {
  const barColor = tone === 'ask' ? 'bg-coral/25' : 'bg-mint/25';
  const baseTint = tone === 'ask' ? 'bg-coral-tint/50' : 'bg-mint-tint/50';
  return (
    <div
      className={`relative flex items-center justify-between px-2 py-[3px] text-[10px] rounded-sm overflow-hidden transition-all duration-300 ${
        highlighted ? 'ring-1 ring-mint bg-mint-tint/70' : baseTint
      }`}
    >
      <span className={`absolute inset-y-0 left-0 ${barColor}`} style={{ width: `${size}%` }} aria-hidden />
      <span className="relative font-body text-ink-2 font-medium">{price}</span>
      <span
        className={`relative font-body font-semibold text-[9px] uppercase tracking-wide transition-opacity duration-300 ${
          highlighted ? 'text-mint-deep opacity-100 animate-pulse' : 'opacity-0'
        }`}
      >
        resting
      </span>
    </div>
  );
}

const REWARD_STEPS = [0.00, 0.02, 0.05, 0.07, 0.09];

function LiquidityRewardsCard({ reducedMotion }: { reducedMotion: boolean }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const active = inView && !reducedMotion;
  const liveStep = useCycle(5, 750, active); // 3.75s loop
  const s = reducedMotion ? 4 : liveStep;
  const askResting = s >= 1;
  const bidResting = s >= 2;
  const reward = REWARD_STEPS[s].toFixed(2);
  const popStyle = usePop(s, active);

  return (
    <CardShell
      chips={['cashable']}
      title="Liquidity rewards"
      desc="Earn real maker rewards for providing liquidity on Polymarket and Kalshi. We show net estimated reward/day and flag any program rate we can't confirm."
      rootRef={ref}
    >
      <div className="w-full h-full flex items-center gap-3 px-3">
        <div className="flex-1 flex flex-col gap-[3px]">
          <BookRow price="0.66" size={40} tone="ask" highlighted={false} />
          <BookRow price="0.64" size={60} tone="ask" highlighted={false} />
          <BookRow price="0.63" size={50} tone="ask" highlighted={askResting} />
          <p className="text-center text-[8.5px] text-muted py-[1px]">&mdash; spread &mdash;</p>
          <BookRow price="0.61" size={55} tone="bid" highlighted={bidResting} />
          <BookRow price="0.59" size={45} tone="bid" highlighted={false} />
          <BookRow price="0.57" size={35} tone="bid" highlighted={false} />
        </div>
        <div className="flex flex-col items-center justify-center flex-shrink-0 w-[70px]">
          <div className="font-display font-bold text-mint-deep text-lg text-center" style={popStyle}>
            ${reward}
          </div>
          <p className="text-[8.5px] text-muted text-center mt-0.5 leading-tight">rewards earned</p>
        </div>
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
