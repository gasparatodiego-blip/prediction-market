'use client';

import { useState } from 'react';
import SectionHelp from '@/app/components/SectionHelp';
import Link from 'next/link';
import {
  Crosshair, Coins, Trophy, ArrowLeftRight, Zap, Landmark,
  ChevronDown, ArrowRight,
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
    id: 'crypto',
    Icon: Coins,
    name: 'Crypto & Funding',
    platforms: ['Binance', 'Bybit', 'OKX'],
    summary: 'Funding rates and spot-futures arbitrage',
    explanation:
      "On perpetual futures, traders pay each other a funding rate. You hold spot plus an offsetting short future (delta-neutral), so you're not exposed to price — you just collect the funding. Realistic returns are modest in calm markets (~5–11%/yr) and higher when funding spikes. Risk: funding can flip; use 1× leverage to avoid liquidation.",
    link: '/dashboard/crypto',
  },
  {
    id: 'sports',
    Icon: Trophy,
    name: 'Sports Arbitrage',
    platforms: ['Bet365', 'DraftKings'],
    summary: 'Surebets across 40+ bookmakers',
    explanation:
      'When bookmakers disagree on odds for the same match, backing every outcome across different books can lock in a profit regardless of the result. The scanner finds these surebets across 40+ books. Risk: bookmakers may limit accounts, and odds move fast.',
    link: '/dashboard/sports',
  },
  {
    id: 'cex',
    Icon: ArrowLeftRight,
    name: 'CEX Arbitrage',
    platforms: ['Binance', 'Coinbase', 'Kraken'],
    summary: 'Price discrepancies across exchanges',
    explanation:
      "The same coin trades at slightly different prices on different exchanges. Buy where it's cheap, sell where it's dear. The scanner flags the gaps in real time. Risk: withdrawal times, transfer fees, and gaps that close within seconds.",
    link: '/dashboard/cex',
  },
  {
    id: 'hft',
    Icon: Zap,
    name: 'HFT 5-min',
    platforms: ['Binance Futures'],
    summary: 'High-frequency algorithmic trading',
    explanation:
      "A higher-frequency strategy that reacts to very short-lived price dislocations on Binance futures. It's automated and noisier — best for users comfortable with frequent small trades. Risk: the highest of the set; tiny edges, very execution-sensitive.",
    link: '/dashboard/hft',
  },
  {
    id: 'lp',
    Icon: Landmark,
    name: 'Liquidity Provider',
    platforms: ['Polymarket LP'],
    summary: 'Earn fees by providing market liquidity',
    explanation:
      "Instead of taking trades, you provide liquidity (e.g. on Polymarket) and earn fees from other people's trades. The scanner tracks your fees and impermanent loss. Risk: impermanent loss can offset fees if prices swing hard.",
    link: '/dashboard/lp',
  },
];

const stats = [
  { value: '14+',  label: 'AI Agents',  color: 'text-accent-bright' },
  { value: '40+',  label: 'Bookmakers', color: 'text-accent' },
  { value: '12+',  label: 'Platforms',  color: 'text-positive' },
  { value: '24/7', label: 'Scanning',   color: 'text-warning' },
];

const generalFaqs = [
  {
    q: 'Which strategy should I start with?',
    a: 'For the steadiest, lowest-stress option, Crypto & Funding (delta-neutral, 1× leverage) is the classic starting point. Prediction-market and sports arbitrage have clearer "locked" edges but need fast execution. HFT is for advanced users only.',
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
  const [selectedId, setSelectedId] = useState('prediction');
  const selected = strategies.find(s => s.id === selectedId) ?? strategies[0];
  const SelectedIcon = selected.Icon;

  return (
    <div>
      <div className="max-w-7xl mx-auto px-4 py-8">

        <SectionHelp section="overview" />

        {/* Header */}
        <div className="mb-8">
          <h2 className="text-base font-semibold text-text-primary font-mono uppercase tracking-widest">
            SELECT STRATEGY
          </h2>
          <p className="text-xs text-text-muted font-mono mt-1">8 automated strategies · 14 AI agents</p>
        </div>

        {/* Strategy cards — master */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {strategies.map((s) => {
            const CardIcon = s.Icon;
            const isSelected = s.id === selectedId;
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
