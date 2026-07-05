'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Zap, Check, Lock, BadgeCheck, AlertTriangle } from 'lucide-react';
import { Redacted } from '@/app/components/ui/Redacted';
import { isLowSample, wrColor, type ActorType } from './format';

// ── Actor-type badge ──────────────────────────────────────────────────────────
// NEVER a bare "BOT". Always type + confidence, with the ⚡HFT tag when flagged.
// actorType is a HEURISTIC inference (trade frequency / market-share / timing),
// not a Polymarket label.

export function ActorBadge({ actor, className = '' }: { actor?: ActorType | null; className?: string }) {
  if (!actor) return null;
  const isBot = actor.type === 'bot';
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span
        title={isBot
          ? `Heuristically flagged as a bot (${actor.confidence}% confidence) — not a Polymarket label`
          : `Looks human (${actor.confidence}% confidence)`}
        className={[
          'font-body text-[9px] font-medium px-1.5 py-[2px] rounded-md border uppercase tracking-wide whitespace-nowrap',
          isBot
            ? 'border-[#2f6fb0]/40 text-[#2f6fb0] bg-[#2f6fb0]/10'
            : 'border-line text-muted bg-bg-soft',
        ].join(' ')}
      >
        {isBot ? 'bot' : 'human'} {actor.confidence}%
      </span>
      {actor.hft && (
        <span
          title="High-frequency trading pattern"
          className="inline-flex items-center gap-0.5 font-body text-[9px] font-semibold px-1.5 py-[2px] rounded-md border border-[#2f6fb0]/40 text-[#2f6fb0] bg-[#2f6fb0]/10 whitespace-nowrap"
        >
          <Zap className="w-2.5 h-2.5" strokeWidth={2.5} />HFT
        </span>
      )}
    </span>
  );
}

export function VerifiedTick({ show }: { show?: boolean }) {
  if (!show) return null;
  return <BadgeCheck className="w-3.5 h-3.5 text-[#0c9d6e] shrink-0" strokeWidth={2.5} aria-label="verified" />;
}

export function LowSampleBadge({ n }: { n: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 font-body text-[9px] font-medium px-1.5 py-[2px] rounded-md bg-gold-tint text-gold border border-gold/25 whitespace-nowrap"
      title={`Only ${n} resolved market${n === 1 ? '' : 's'} — win rate is noise, not skill. Ranked by Wilson score, which discounts tiny samples.`}
    >
      <AlertTriangle className="w-2.5 h-2.5" strokeWidth={2.5} />low sample ({n})
    </span>
  );
}

// Canonical win-rate renderer — used on the leaderboard row, profile hero, and
// bots tab. ALWAYS shows the sample context: "<winRate>% · w<wilsonScore>" plus
// a "⚠ low sample (N)" badge when thin. A bare "100%" is never shown. Win% is
// muted for low-sample wallets so luck doesn't read as a headline stat. Redaction
// intact: winRate null (free tier) → lock UI, never $0.
export function WinRate({
  winRate, wilson, resolvedMarkets,
}: {
  winRate:         number | null;
  wilson:          number | null;
  resolvedMarkets: number;
}) {
  const low = isLowSample(resolvedMarkets);
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span className={low ? 'text-muted' : wrColor(winRate)}>
        <Redacted value={winRate}>{v => `${v.toFixed(0)}%`}</Redacted>
        {/* wilsonScore is a 0–1 fraction (agent20 Wilson 95% lower bound); render
            it as a percent — 0.9874 → "w99", NOT "w1". This is the sample-robust
            skill metric the board is ranked by. */}
        {wilson != null && (
          <span className="font-body text-[11px] text-muted font-normal ml-1">· w{Math.round(wilson * 100)}</span>
        )}
      </span>
      {low && <LowSampleBadge n={resolvedMarkets} />}
    </span>
  );
}

export function CategoryTag({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`font-body text-[9px] font-medium px-1.5 py-[2px] rounded-md border border-line bg-bg-soft uppercase tracking-wide whitespace-nowrap ${colorClass}`}>
      {label}
    </span>
  );
}

// Blue confidence meter for the Bots/HFT tab.
export function ConfidenceBar({ pct }: { pct: number }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-[#2f6fb0]/12 rounded-full overflow-hidden min-w-[60px]">
        <div className="h-full bg-[#2f6fb0]/70 rounded-full" style={{ width: `${w}%` }} />
      </div>
      <span className="font-body text-[10px] text-[#2f6fb0] tabular-nums w-8 text-right">{w}%</span>
    </div>
  );
}

// ── Copy slot button (tier gating) ────────────────────────────────────────────
// Slot MANAGEMENT + persistence only. NO trade is executed here — real copy-
// follow execution (wiring to agent21) is a SEPARATE, security-hardening-gated
// commit. This button only reserves a local "signal-follow" slot and persists it.

export function CopyButton({
  copying, atLimit, tier, maxSlots, onToggle, size = 'sm',
}: {
  copying:  boolean;
  atLimit:  boolean;   // slots full AND this trader is not one of them
  tier:     'free' | 'pro';
  maxSlots: number;
  onToggle: () => void;
  size?:    'sm' | 'lg';
}) {
  const [showUpgrade, setShowUpgrade] = useState(false);
  const pad = size === 'lg' ? 'px-3 py-1.5 text-[11px]' : 'px-2.5 py-1 text-[10px]';

  function handle() {
    if (!copying && atLimit) { setShowUpgrade(true); return; }
    setShowUpgrade(false);
    onToggle();
  }

  const base = `inline-flex items-center gap-1 rounded-button border font-body font-medium uppercase tracking-wide transition-colors whitespace-nowrap ${pad}`;

  let cls: string, label: React.ReactNode;
  if (copying) {
    cls = 'border-[#0c9d6e]/50 text-[#0c9d6e] bg-mint-tint hover:border-coral-ink/40 hover:text-coral-ink hover:bg-coral-tint';
    label = <><Check className="w-2.5 h-2.5" strokeWidth={3} />Copying</>;
  } else if (atLimit) {
    cls = 'border-line text-muted bg-bg-soft cursor-pointer';
    label = <><Lock className="w-2.5 h-2.5" />Slots full</>;
  } else {
    cls = 'border-line text-muted hover:border-[#0c9d6e]/45 hover:text-[#0c9d6e] hover:bg-mint-tint';
    label = 'Copy';
  }

  return (
    <span className="relative inline-flex">
      <button type="button" onClick={(e) => { e.stopPropagation(); handle(); }} className={`${base} ${cls}`}>
        {label}
      </button>

      {showUpgrade && (
        <span
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full mt-1.5 z-20 w-56 p-2.5 rounded-card border border-line bg-surface shadow-card text-left"
        >
          <span className="block font-body text-[10px] text-ink-2 leading-snug mb-1.5">
            {tier === 'free'
              ? `Free copies ${maxSlots} trader. Upgrade to Pro for 2 active copy slots.`
              : `All ${maxSlots} copy slots are in use — remove one to add another.`}
          </span>
          {tier === 'free' && (
            <Link
              href="/dashboard/upgrade"
              className="inline-block font-body text-[10px] font-medium text-[#0c9d6e] hover:text-mint-deep underline underline-offset-2"
            >
              Upgrade to Pro →
            </Link>
          )}
          <button
            onClick={() => setShowUpgrade(false)}
            className="block mt-1.5 font-body text-[9px] text-muted hover:text-ink"
          >
            dismiss
          </button>
        </span>
      )}
    </span>
  );
}
