'use client';

import { useState } from 'react';
import SectionHelp from '@/app/components/SectionHelp';
import Link from 'next/link';
import {
  Crosshair, Coins, Trophy, Users,
  ChevronDown, ArrowRight, GitMerge,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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
    id: 'crypto',
    Icon: Coins,
    name: 'Funding Arb',
    platforms: ['Binance', 'Bybit', 'OKX'],
    summary: 'Funding rates and spot-futures arbitrage',
    explanation:
      "On perpetual futures, traders pay each other a funding rate. You hold spot plus an offsetting short future (delta-neutral), so you're not exposed to price — you just collect the funding. Realistic returns are modest in calm markets (~5–11%/yr) and higher when funding spikes. Risk: funding can flip; use 1× leverage to avoid liquidation.",
    link: '/dashboard/funding-arb',
  },
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
    platforms: ['Bet365', 'DraftKings', 'OddsAPI'],
    summary: 'Surebets across 40+ bookmakers — soft-book filter in progress',
    explanation:
      'When bookmakers disagree on odds for the same match, backing every outcome across different books can lock in a profit regardless of the result. The scanner finds these surebets across 40+ books via OddsAPI. The soft-book false-positive filter is not yet built — enabling live output now would show unreliable results. Coming soon.',
    link: '/dashboard/sports',
    comingSoon: true,
  },
];

const stats = [
  { value: '6',    label: 'Live Agents',  color: 'text-accent-bright' },
  { value: '9+',   label: 'Venues',       color: 'text-accent' },
  { value: '40+',  label: 'Bookmakers',   color: 'text-positive' },
  { value: '24/7', label: 'Scanning',     color: 'text-warning' },
];

const generalFaqs = [
  {
    q: 'Which strategy should I start with?',
    a: 'For the steadiest, lowest-stress option, Crypto & Funding (delta-neutral, 1× leverage) is the classic starting point. Cash & Carry locks in a basis at entry and holds to expiry — lower variance, no rate-flip risk. Prediction-market and sports arbitrage have clearer "locked" edges but need fast execution and account access.',
  },
  {
    q: 'Is the profit guaranteed?',
    a: 'No. Arbitrage edges are real but not risk-free — fees, slippage, partial fills, account limits, and edges closing before you execute can all reduce or erase profit. ArbScanner shows opportunities with net-of-fee estimates; you decide and execute. This is not financial advice.',
  },
  {
    q: 'Free vs Pro vs Profit Share?',
    a: 'Free: top 3 opportunities, 5-minute delay. Pro (€15/mo): unlimited, real-time, Telegram + email alerts, Kelly sizing. Profit Share: €0 up front, you pay 10% of verified profits.',
  },
];

function AccordionItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center justify-between py-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        <span className="text-sm text-text-primary font-mono pr-4">{q}</span>
        <ChevronDown
          className={`w-4 h-4 text-text-muted shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <p className="pb-4 text-sm text-text-secondary font-mono leading-relaxed">{a}</p>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const [selectedId, setSelectedId] = useState('crypto');
  const selected = strategies.find(s => s.id === selectedId) ?? strategies[0];
  const SelectedIcon = selected.Icon;

  return (
    <div>
      <div className="max-w-7xl mx-auto px-4 py-8">

        <SectionHelp section="overview" />

        {/* Header */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-text-primary font-mono mb-1">
            Choose the category that interests you most
          </h2>
          <p className="text-xs text-text-muted font-mono">5 strategies · live agents running 24/7 · select one to see current opportunities</p>
        </div>

        {/* Strategy cards — master */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {strategies.map((s) => {
            const CardIcon = s.Icon;
            const isSelected = s.id === selectedId;

            if (s.comingSoon) {
              return (
                <div
                  key={s.id}
                  className="p-5 rounded border text-left w-full h-full border-border bg-bg-panel opacity-45 cursor-not-allowed"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0">
                      <CardIcon className="w-5 h-5 text-accent" />
                    </div>
                    <div className="min-w-0 w-full">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <h3 className="font-semibold text-text-primary text-sm">{s.name}</h3>
                        <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-text-muted border border-border px-1.5 py-0.5 shrink-0">
                          COMING SOON
                        </span>
                      </div>
                      <p className="text-xs text-text-secondary leading-relaxed">{s.summary}</p>
                      <div className="flex flex-wrap gap-1 mt-3">
                        {s.platforms.map(p => (
                          <span
                            key={p}
                            className="text-xs px-1.5 py-0.5 rounded border border-border bg-bg-elevated font-mono uppercase tracking-wide text-text-secondary"
                          >
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
                  'p-5 rounded border text-left w-full h-full transition-all duration-100 cursor-pointer',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60',
                  isSelected
                    ? 'border-accent bg-bg-elevated'
                    : 'border-border bg-bg-panel hover:bg-bg-elevated hover:border-accent/20',
                ].join(' ')}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 shrink-0">
                    <CardIcon className="w-5 h-5 text-accent" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-text-primary text-sm">{s.name}</h3>
                    <p className="text-xs text-text-secondary mt-1 leading-relaxed">{s.summary}</p>
                    <div className="flex flex-wrap gap-1 mt-3">
                      {s.platforms.map(p => (
                        <span
                          key={p}
                          className="text-xs px-1.5 py-0.5 rounded border border-border bg-bg-elevated font-mono uppercase tracking-wide text-text-secondary"
                        >
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
        <div className="mt-4 border border-border bg-bg-panel">
          <div key={selectedId} className="animate-fade-in p-6 flex flex-col sm:flex-row sm:items-start gap-6">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-3">
                <SelectedIcon className="w-6 h-6 text-accent shrink-0" />
                <span className="font-semibold text-text-primary text-sm">{selected.name}</span>
              </div>
              <p className="text-sm text-text-secondary font-mono leading-relaxed">
                {selected.explanation}
              </p>
              <div className="flex flex-wrap gap-1 mt-4">
                {selected.platforms.map(p => (
                  <span
                    key={p}
                    className="text-xs px-1.5 py-0.5 border border-border bg-bg-elevated font-mono uppercase tracking-wide text-text-secondary"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
            <div className="shrink-0">
              <Link
                href={selected.link}
                className="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white font-mono text-xs uppercase tracking-wider hover:bg-accent-bright transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
              >
                OPEN {selected.name.toUpperCase()}
                <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
          </div>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-10 pt-6 border-t border-border text-center">
          {stats.map(s => (
            <div key={s.label}>
              <div className={`text-2xl font-bold font-mono tabular-nums ${s.color}`}>{s.value}</div>
              <div className="text-xs text-text-muted font-mono uppercase tracking-wider mt-1">{s.label}</div>
            </div>
          ))}
        </div>

        {/* General FAQ */}
        <div className="mt-16">
          <p className="font-mono text-xs text-text-muted uppercase tracking-widest mb-6">FAQ</p>
          <div>
            {generalFaqs.map((item, i) => (
              <AccordionItem key={i} q={item.q} a={item.a} />
            ))}
            <div className="border-t border-border" />
          </div>
        </div>

      </div>

      {/* Disclaimer band */}
      <div className="border-t border-border mt-12">
        <div className="max-w-7xl mx-auto px-4 py-5 flex flex-col sm:flex-row items-center justify-center gap-4 text-center">
          <p className="font-mono text-xs text-text-muted">
            Net-of-fee estimates only · Markets carry risk · Always verify before trading · Not financial advice.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-1.5 h-1.5 rounded-full bg-positive" />
            <span className="font-mono text-xs text-text-muted">ALL SYSTEMS OPERATIONAL</span>
          </div>
        </div>
      </div>
    </div>
  );
}
