'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Crosshair, Trophy, Users,
  ChevronDown, ChevronRight, ArrowRight, GitMerge, Gift,
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
  howItWorks: string;
  link: string;
  comingSoon?: boolean;
}

const strategies: Strategy[] = [
  {
    id: 'prediction',
    Icon: Crosshair,
    name: 'Prediction Markets',
    platforms: ['Polymarket', 'Kalshi', 'PredictIt'],
    summary: 'One event, two venues, two prices',
    explanation:
      'When the same event (e.g. an election result) is priced differently on Polymarket, Kalshi and PredictIt, you buy the cheaper side and hedge the other. If the combined cost is below the guaranteed payout, the difference is your edge — no matter who wins. Risk: prices can move before both legs fill, and fees eat thin spreads.',
    howItWorks:
      'The same event is listed on more than one venue, and their prices do not always agree. When the total cost to cover every outcome across venues is less than the fixed payout, that gap is locked the moment both legs fill — who actually wins no longer matters. Edgeradar surfaces those gaps net of fees; you place the orders.',
    link: '/dashboard/prediction',
  },
  {
    id: 'carry',
    Icon: GitMerge,
    name: 'Cash & Carry',
    platforms: ['Binance', 'OKX', 'Deribit'],
    summary: 'Buy spot, short the future, hold to expiry',
    explanation:
      'Buy spot and simultaneously short a dated (quarterly) futures contract on the same exchange. At expiry the future delivers at spot price, so the gap (basis) you locked in at entry is your return — regardless of where the price goes. Risk: exchange counterparty risk over the hold period. Coin-margined contracts settle in the coin, not USDT — USD return is not fully locked.',
    howItWorks:
      'Buy the asset spot and short a dated futures contract on it at the same time. At expiry the future settles into spot, so the basis you captured at entry becomes your return regardless of which way the price moved. Nothing to predict — the edge is fixed at entry and realised on the calendar.',
    link: '/dashboard/carry',
  },
  {
    id: 'rewards',
    Icon: Gift,
    name: 'Liquidity Rewards',
    platforms: ['Polymarket', 'Kalshi'],
    summary: 'Get paid daily to quote both sides of the book',
    explanation:
      'Some venues pay daily rewards to market makers who post resting limit orders near the midpoint. You quote both sides within the reward band and collect a share of the daily pool proportional to your posted size and time-in-book. Returns are modest and depend on competition. Risk: your orders can fill (leaving you with a position), and rewards shrink as more makers crowd the same band. No orders are placed for you — this is a scanner.',
    howItWorks:
      'Some venues pay a daily pool to market makers who post resting orders near the midpoint. You quote both sides inside the reward band and earn a share of that pool for the size you post and the time it stays on the book. It pays for providing liquidity, not for calling a direction — and Edgeradar only counts rewards that actually accrued.',
    link: '/dashboard/liquidity-rewards',
  },
  {
    id: 'traders',
    Icon: Users,
    name: 'Traders Hub',
    platforms: ['Polymarket'],
    summary: 'Follow the wallets that win — read-only, no keys',
    explanation:
      'Browse the Polymarket realized P&L leaderboard by category (Politics, Sports, Crypto, Pop Culture, World), follow any wallet, and get Telegram alerts when followed traders make new trades. No private keys collected at any step. Auto-copy execution is locked pending security hardening (step 2 of 3). Past P&L ≠ future results. Not financial advice.',
    howItWorks:
      'Every Polymarket trade, the wallet behind it, and what that wallet has actually made once its positions settled are all public. Edgeradar ranks wallets on realised profit, lets you follow any of them, and alerts you when they trade. It is read-only: no keys are taken and nothing is executed for you.',
    link: '/dashboard/traders',
  },
  {
    id: 'sports',
    Icon: Trophy,
    name: 'Sports Arb',
    platforms: ['EU·UK·US Books'],
    summary: 'When books disagree on a match, back every side',
    explanation:
      'When bookmakers disagree on odds for the same match, backing every outcome across different books locks in a profit regardless of result. Phase A: periodic snapshot scanner (EU·UK·US h2h, on-demand run). Opportunities survive a 4-book minimum gate, a median outlier filter that removes suspiciously generous prices, and a 6% ROI plausibility cap. Preview only — no orders placed.',
    howItWorks:
      'Bookmakers price the same match differently. Backing every outcome across the books that offer the best price on each side locks a return no matter who wins. Edgeradar compares live prices, filters out suspiciously generous outliers, and shows only spreads that clear a plausibility gate — you place the bets.',
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
  // Accordion: the card body toggles its own HOW IT WORKS panel open/closed.
  // null = all collapsed (default). Once expanded, tapping anywhere on the card
  // navigates to the strategy page; the arrow stays the collapse/expand toggle.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const router = useRouter();

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
            const isExpanded = s.id === expandedId;
            // One shared behaviour for every card: the arrow always toggles;
            // once expanded, a tap anywhere on the card opens the strategy page.
            const toggle   = () => setExpandedId(prev => (prev === s.id ? null : s.id));
            const openPage = () => router.push(s.link);

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
              // Accordion card: the body button toggles HOW IT WORKS; the arrow
              // (top-right) and the in-panel button both open the strategy page.
              // Same tokens/borders as before — only the interaction is new.
              <div
                key={s.id}
                onClick={isExpanded ? openPage : undefined}
                className={[
                  'p-5 rounded-card w-full h-full transition-all duration-150',
                  spanCls,
                  isExpanded
                    ? 'bg-surface border-2 border-mint-deep shadow-card cursor-pointer'
                    : 'bg-surface border border-line shadow-card hover:border-mint/40 hover:shadow-[0_2px_12px_rgba(15,190,130,.08)]',
                ].join(' ')}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => { if (!isExpanded) toggle(); }}
                    aria-expanded={isExpanded}
                    className="flex items-start gap-3 flex-1 min-w-0 text-left cursor-pointer rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50"
                  >
                    <div className={`mt-0.5 shrink-0 ${isExpanded ? 'text-mint-deep' : 'text-muted'}`}>
                      <CardIcon className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <h3 className={`font-body font-semibold text-sm ${isExpanded ? 'text-mint-deep' : 'text-ink'}`}>
                        {s.name}
                      </h3>
                      <p className="font-body text-xs text-ink-2 mt-1 leading-relaxed">{s.summary}</p>
                      <div className="flex flex-wrap gap-1 mt-3">
                        {s.platforms.map(p => (
                          <span
                            key={p}
                            className={`inline-flex items-center gap-1 font-body text-[11px] px-2 py-0.5 rounded-pill border ${
                              isExpanded
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
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggle(); }}
                    aria-expanded={isExpanded}
                    aria-label={isExpanded ? `Collapse ${s.name}` : `Expand ${s.name}`}
                    className="shrink-0 -mr-1 -mt-1 p-1 rounded-button text-muted hover:text-mint-deep transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>

                {isExpanded && (
                  <div className="mt-4 pt-4 border-t border-line">
                    <p className="font-body text-xs text-ink-2 leading-relaxed">{s.howItWorks}</p>
                    <Link
                      href={s.link}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-mint-deep text-white font-body font-medium text-sm rounded-button hover:bg-mint transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50"
                    >
                      Open {s.name}
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                )}
              </div>
            );
          })}
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
