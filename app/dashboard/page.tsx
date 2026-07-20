'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Crosshair, Trophy, Users,
  ChevronDown, ArrowRight, GitMerge, Gift,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Eyebrow from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import StatCard from '@/app/components/ui/StatCard';
import RadarScope from '@/app/components/ui/RadarScope';
import PlatformLogo from '@/components/PlatformLogo';
import type { Blip } from '@/app/components/ui/RadarScope';

interface Strategy {
  id: string;
  Icon: LucideIcon;
  name: string;
  platforms: string[];
  summary: string;
  explanation: string;
  link: string;
  comingSoon?: boolean;
}

const strategies: Strategy[] = [
  {
    id: 'prediction',
    Icon: Crosshair,
    name: 'Prediction Markets',
    platforms: ['Polymarket', 'Kalshi', 'PredictIt'],
    summary: 'Arbitrage on political, sports & current events',
    explanation:
      'When the same event (e.g. an election result) is priced differently on Polymarket, Kalshi and PredictIt, you buy the cheaper side and hedge the other. If the combined cost is below the guaranteed payout, the difference is your edge — no matter who wins. Risk: prices can move before both legs fill, and fees eat thin spreads.',
    link: '/dashboard/prediction',
  },
  {
    id: 'carry',
    Icon: GitMerge,
    name: 'Cash & Carry',
    platforms: ['Binance', 'OKX', 'Deribit'],
    summary: 'Locked basis return via spot + dated futures',
    explanation:
      'Buy spot and simultaneously short a dated (quarterly) futures contract on the same exchange. At expiry the future delivers at spot price, so the gap (basis) you locked in at entry is your return — regardless of where the price goes. Risk: exchange counterparty risk over the hold period. Coin-margined contracts settle in the coin, not USDT — USD return is not fully locked.',
    link: '/dashboard/carry',
  },
  {
    id: 'rewards',
    Icon: Gift,
    name: 'Liquidity Rewards',
    platforms: ['Polymarket', 'Kalshi'],
    summary: 'Earn daily by posting maker orders (Polymarket + Kalshi)',
    explanation:
      'Some venues pay daily rewards to market makers who post resting limit orders near the midpoint. You quote both sides within the reward band and collect a share of the daily pool proportional to your posted size and time-in-book. Returns are modest and depend on competition. Risk: your orders can fill (leaving you with a position), and rewards shrink as more makers crowd the same band. No orders are placed for you — this is a scanner.',
    link: '/dashboard/liquidity-rewards',
  },
  {
    id: 'traders',
    Icon: Users,
    name: 'Traders Hub',
    platforms: ['Polymarket'],
    summary: 'Leaderboard + follow + alerts — one place, read-only, zero keys',
    explanation:
      'Browse the Polymarket realized P&L leaderboard by category (Politics, Sports, Crypto, Pop Culture, World), follow any wallet, and get Telegram alerts when followed traders make new trades. No private keys collected at any step. Auto-copy execution is locked pending security hardening (step 2 of 3). Past P&L ≠ future results. Not financial advice.',
    link: '/dashboard/traders',
  },
  {
    id: 'sports',
    Icon: Trophy,
    name: 'Sports Arb',
    platforms: ['EU·UK·US Books'],
    summary: 'Cross-bookmaker surebet scanner — outlier-filtered, credit-safe snapshot',
    explanation:
      'When bookmakers disagree on odds for the same match, backing every outcome across different books locks in a profit regardless of result. Phase A: periodic snapshot scanner (EU·UK·US h2h, on-demand run). Opportunities survive a 4-book minimum gate, a median outlier filter that removes suspiciously generous prices, and a 6% ROI plausibility cap. Preview only — no orders placed.',
    link: '/dashboard/sports',
  },
];

const stats = [
  { value: '6',    label: 'Live Agents' },
  { value: '9+',   label: 'Venues'      },
  { value: '40+',  label: 'Bookmakers'  },
  { value: '24/7', label: 'Scanning'    },
];

const generalFaqs = [
  {
    q: 'Which strategy should I start with?',
    a: 'For the steadiest, lowest-stress option, Cash & Carry locks in a basis at entry and holds to expiry — lower variance, nothing to predict. Prediction-market and sports arbitrage have clearer "locked" edges but need fast execution and account access. Liquidity Rewards pays for posting quotes rather than for calling a direction.',
  },
  {
    q: 'Is the profit guaranteed?',
    a: 'No. Arbitrage edges are real but not risk-free — fees, slippage, partial fills, account limits, and edges closing before you execute can all reduce or erase profit. Edgeradar shows opportunities with net-of-fee estimates; you decide and execute. This is not financial advice.',
  },
  {
    q: 'Free vs Pro vs Profit Share?',
    a: 'Free: top 3 opportunities, 5-minute delay. Pro (€15/mo): unlimited, real-time, Telegram + email alerts, Kelly sizing. Profit Share: €0 up front, you pay 10% of verified profits.',
  },
];

// Offset (in 6-col tracks) → the literal Tailwind class that centres a short
// final grid row. Keyed by leftover-tracks/2; only 1 and 2 can occur with a
// 3-per-row layout, i.e. a final row of two cards or of one.
const LG_COL_START: Record<number, string> = {
  1: 'lg:col-start-2',
  2: 'lg:col-start-3',
};

const RADAR_BLIPS: Blip[] = [
  { top: '30%', left: '65%', color: 'mint'   },
  { top: '60%', left: '25%', color: 'violet' },
  { top: '75%', left: '72%', color: 'gold'   },
];

function AccordionItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-line">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center justify-between py-4 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mint/60"
      >
        <span className="font-body text-sm text-ink pr-4">{q}</span>
        <ChevronDown
          className={`w-4 h-4 text-muted shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <p className="pb-4 font-body text-sm text-ink-2 leading-relaxed">{a}</p>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const [selectedId, setSelectedId] = useState('prediction');
  const selected     = strategies.find(s => s.id === selectedId) ?? strategies[0];
  const SelectedIcon = selected.Icon;

  return (
    // .dsskin re-points the light semantic utilities onto the ds palette for this page
    // only. No markup, table, column or data binding below changes — see globals.css.
    <div className="dsskin">
      <div className="dash-container px-4 py-10">

        {/* Header */}
        <div className="flex items-start justify-between gap-6 mb-8">
          <div>
            <Eyebrow className="mb-2">{strategies.length} strategies · live 24/7</Eyebrow>
            <SectionHeading className="text-2xl">
              Choose a strategy to explore
            </SectionHeading>
          </div>
          <RadarScope size={64} blips={RADAR_BLIPS} className="shrink-0 hidden sm:block" />
        </div>

        {/* Strategy cards — master */}
        {/* 6-col track at lg so an odd card count still reads intentional: rows of
            three, then a centered final row. On md the trailing card spans both
            columns instead of sitting orphaned; on mobile it is a plain stack. */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
          {strategies.map((s, idx) => {
            const CardIcon   = s.Icon;
            const isSelected = s.id === selectedId;

            const perRow    = 3;
            const lastRowN  = strategies.length % perRow;               // cards in the final lg row
            const firstLast = strategies.length - (lastRowN || perRow); // index that starts it
            const spanCls = [
              'lg:col-span-2',
              idx === strategies.length - 1 && strategies.length % 2 === 1 ? 'md:col-span-2' : '',
              // centre a short final row by offsetting its first card.
              // Literal classes only — Tailwind's scanner cannot see interpolated ones.
              lastRowN > 0 && idx === firstLast ? LG_COL_START[perRow - lastRowN] ?? '' : '',
            ].filter(Boolean).join(' ');

            if (s.comingSoon) {
              return (
                <div
                  key={s.id}
                  className={`p-5 rounded-card bg-surface border border-line opacity-40 cursor-not-allowed ${spanCls}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0">
                      <CardIcon className="w-5 h-5 text-muted" />
                    </div>
                    <div className="min-w-0 w-full">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <h3 className="font-body font-semibold text-sm text-ink">{s.name}</h3>
                        <span className="font-body text-[9px] uppercase tracking-[0.15em] text-muted border border-line px-1.5 py-0.5 rounded-pill shrink-0">
                          COMING SOON
                        </span>
                      </div>
                      <p className="font-body text-xs text-ink-2 leading-relaxed">{s.summary}</p>
                      <div className="flex flex-wrap gap-1 mt-3">
                        {s.platforms.map(p => (
                          <span
                            key={p}
                            className="inline-flex items-center gap-1 font-body text-[11px] px-2 py-0.5 rounded-pill border border-line bg-bg-soft text-muted"
                          >
                            {p !== 'EU·UK·US Books' && <PlatformLogo platform={p} size={11} />}
                            {p}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }

            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={[
                  'p-5 rounded-card text-left w-full h-full transition-all duration-150 cursor-pointer',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50',
                  spanCls,
                  isSelected
                    ? 'bg-surface border-2 border-mint-deep shadow-card'
                    : 'bg-surface border border-line shadow-card hover:border-mint/40 hover:shadow-[0_2px_12px_rgba(15,190,130,.08)]',
                ].join(' ')}
              >
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 shrink-0 ${isSelected ? 'text-mint-deep' : 'text-muted'}`}>
                    <CardIcon className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <h3 className={`font-body font-semibold text-sm ${isSelected ? 'text-mint-deep' : 'text-ink'}`}>
                      {s.name}
                    </h3>
                    <p className="font-body text-xs text-ink-2 mt-1 leading-relaxed">{s.summary}</p>
                    <div className="flex flex-wrap gap-1 mt-3">
                      {s.platforms.map(p => (
                        <span
                          key={p}
                          className={`inline-flex items-center gap-1 font-body text-[11px] px-2 py-0.5 rounded-pill border ${
                            isSelected
                              ? 'border-mint/30 bg-mint-tint text-mint-deep'
                              : 'border-line bg-bg-soft text-muted'
                          }`}
                        >
                          {p !== 'EU·UK·US Books' && <PlatformLogo platform={p} size={11} />}
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Detail panel */}
        <div className="mt-5 rounded-panel bg-surface border border-line shadow-card">
          <div key={selectedId} className="p-6 flex flex-col sm:flex-row sm:items-start gap-6">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-3">
                <SelectedIcon className="w-5 h-5 text-mint-deep shrink-0" />
                <span className="font-body font-semibold text-sm text-ink">{selected.name}</span>
              </div>
              <p className="font-body text-sm text-ink-2 leading-relaxed">
                {selected.explanation}
              </p>
              <div className="flex flex-wrap gap-1.5 mt-4">
                {selected.platforms.map(p => (
                  <span
                    key={p}
                    className="inline-flex items-center gap-1 font-body text-[11px] px-2 py-0.5 border border-line bg-bg-soft rounded-pill text-muted"
                  >
                    {p !== 'EU·UK·US Books' && <PlatformLogo platform={p} size={11} />}
                    {p}
                  </span>
                ))}
              </div>
            </div>
            <div className="shrink-0">
              <Link
                href={selected.link}
                className="inline-flex items-center gap-2 px-4 py-2 bg-mint-deep text-white font-body font-medium text-sm rounded-button hover:bg-mint transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50"
              >
                Open {selected.name}
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-10">
          {stats.map(s => (
            <StatCard key={s.label} value={s.value} label={s.label} />
          ))}
        </div>

        {/* General FAQ */}
        <div className="mt-16">
          <Eyebrow className="mb-3">FAQ</Eyebrow>
          <div>
            {generalFaqs.map((item, i) => (
              <AccordionItem key={i} q={item.q} a={item.a} />
            ))}
            <div className="border-t border-line" />
          </div>
        </div>

      </div>

      {/* Disclaimer band */}
      <div className="border-t border-line mt-12">
        <div className="dash-container px-4 py-5 flex flex-col sm:flex-row items-center justify-center gap-4 text-center">
          <p className="font-body text-xs text-muted">
            Net-of-fee estimates only · Markets carry risk · Always verify before trading · Not financial advice.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-1.5 h-1.5 rounded-full bg-mint" />
            <span className="font-body text-xs text-muted">ALL SYSTEMS OPERATIONAL</span>
          </div>
        </div>
      </div>
    </div>
  );
}
