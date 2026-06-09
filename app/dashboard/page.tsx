'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Crosshair, Coins, Trophy, ArrowLeftRight, Zap, Landmark, Search, BarChart2, Play, ChevronDown } from 'lucide-react';

const ICON_CLASS = 'w-5 h-5 text-accent';

const categories = [
  {
    id: 'prediction',
    icon: <Crosshair className={ICON_CLASS} />,
    name: 'Prediction Markets',
    platforms: ['Polymarket', 'Kalshi', 'PredictIt'],
    summary: 'Arbitrage on political, sports & current events',
    link: '/dashboard/prediction',
  },
  {
    id: 'crypto',
    icon: <Coins className={ICON_CLASS} />,
    name: 'Crypto & Funding',
    platforms: ['Binance', 'Bybit', 'OKX'],
    summary: 'Funding rates and spot-futures arbitrage',
    link: '/dashboard/crypto',
  },
  {
    id: 'sports',
    icon: <Trophy className={ICON_CLASS} />,
    name: 'Sports Arbitrage',
    platforms: ['Bet365', 'DraftKings'],
    summary: 'Surebets across 40+ bookmakers',
    link: '/dashboard/sports',
  },
  {
    id: 'cex',
    icon: <ArrowLeftRight className={ICON_CLASS} />,
    name: 'CEX Arbitrage',
    platforms: ['Binance', 'Coinbase', 'Kraken'],
    summary: 'Price discrepancies across exchanges',
    link: '/dashboard/cex',
  },
  {
    id: 'hft',
    icon: <Zap className={ICON_CLASS} />,
    name: 'HFT 5-min',
    platforms: ['Binance Futures'],
    summary: 'High-frequency algorithmic trading',
    link: '/dashboard/hft',
  },
  {
    id: 'lp',
    icon: <Landmark className={ICON_CLASS} />,
    name: 'Liquidity Provider',
    platforms: ['Polymarket LP'],
    summary: 'Earn fees by providing market liquidity',
    link: '/dashboard/lp',
  },
];

const stats = [
  { value: '14+', label: 'AI Agents',  color: 'text-accent-bright' },
  { value: '40+', label: 'Bookmakers', color: 'text-accent' },
  { value: '12+', label: 'Platforms',  color: 'text-positive' },
  { value: '24/7', label: 'Scanning',  color: 'text-warning' },
];

const steps = [
  {
    num: '01',
    label: 'SCAN',
    icon: <Search className="w-6 h-6 text-accent" />,
    text: '14 AI agents scan 400+ markets across 12+ platforms every 30 seconds.',
  },
  {
    num: '02',
    label: 'RANK',
    icon: <BarChart2 className="w-6 h-6 text-accent" />,
    text: 'Claude AI ranks every gap by real, net-of-fee profit potential.',
  },
  {
    num: '03',
    label: 'EXECUTE',
    icon: <Play className="w-6 h-6 text-accent" />,
    text: 'You get step-by-step instructions and act on the opportunities you choose.',
  },
];

const faqs = [
  {
    q: 'How does ArbScanner actually make me money?',
    a: "ArbScanner doesn't trade for you automatically — it continuously scans 400+ markets across 12+ platforms and surfaces price gaps where the same outcome is priced differently. You decide which ones to act on. Each strategy below is a different kind of gap.",
  },
  {
    q: 'Prediction Market Arbitrage — how does it work?',
    a: 'When the same event (e.g. an election result) is priced differently on Polymarket, Kalshi and PredictIt, you buy the cheaper side and hedge the other. If the combined cost is below the guaranteed payout, the difference is your edge — no matter who wins. Risk: prices can move before both legs fill, and fees eat thin spreads.',
  },
  {
    q: 'Crypto & Funding — how does it work?',
    a: 'On perpetual futures, traders pay each other a "funding rate." You hold spot plus an offsetting short future (delta-neutral), so you\'re not exposed to price — you just collect the funding. Realistic returns are modest in calm markets (~5–11%/yr) and higher when funding spikes. Risk: funding can flip; use 1× leverage to avoid liquidation.',
  },
  {
    q: 'Sports Arbitrage (surebets) — how does it work?',
    a: 'When bookmakers disagree on odds for the same match, backing every outcome across different books can lock in a profit regardless of the result. The scanner finds these surebets across 40+ books. Risk: bookmakers may limit accounts, and odds move fast.',
  },
  {
    q: 'CEX Arbitrage — how does it work?',
    a: "The same coin trades at slightly different prices on different exchanges. Buy where it's cheap, sell where it's dear. The scanner flags the gaps in real time. Risk: withdrawal times, transfer fees, and gaps that close within seconds.",
  },
  {
    q: 'HFT 5-min — how does it work?',
    a: "A higher-frequency strategy that reacts to very short-lived price dislocations on Binance futures. It's automated and noisier — best for users comfortable with frequent small trades. Risk: the highest of the set; tiny edges, very execution-sensitive.",
  },
  {
    q: 'Liquidity Provider — how does it work?',
    a: "Instead of taking trades, you provide liquidity (e.g. on Polymarket) and earn fees from other people's trades. The scanner tracks your fees and impermanent loss. Risk: impermanent loss can offset fees if prices swing hard.",
  },
  {
    q: 'Which strategy should I start with?',
    a: 'For the steadiest, lowest-stress option, Crypto & Funding (delta-neutral, 1× leverage) is the classic starting point. Prediction-market and sports arbitrage have clearer "locked" edges but need fast execution. HFT is for advanced users only.',
  },
  {
    q: 'Is the profit guaranteed?',
    a: 'No. Arbitrage edges are real but not risk-free — fees, slippage, partial fills, account limits, and edges closing before you execute can all reduce or erase profit. ArbScanner shows opportunities with net-of-fee estimates; you decide and execute. This is not financial advice.',
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
  return (
    <div>
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h2 className="text-base font-semibold text-text-primary font-mono uppercase tracking-widest">SELECT STRATEGY</h2>
          <p className="text-xs text-text-muted font-mono mt-1">8 automated strategies · 14 AI agents</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {categories.map((cat) => (
            <Link key={cat.id} href={cat.link}>
              <div className="p-5 rounded border border-border bg-bg-panel hover:bg-bg-elevated hover:border-accent/20 transition-all duration-100 cursor-pointer h-full">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 shrink-0">{cat.icon}</div>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-text-primary text-sm">{cat.name}</h3>
                    <p className="text-xs text-text-secondary mt-1 leading-relaxed">{cat.summary}</p>
                    <div className="flex flex-wrap gap-1 mt-3">
                      {cat.platforms.map(p => (
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
            </Link>
          ))}
        </div>

        {/* Bottom stats bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-10 pt-6 border-t border-border text-center">
          {stats.map(s => (
            <div key={s.label}>
              <div className={`text-2xl font-bold font-mono tabular-nums ${s.color}`}>{s.value}</div>
              <div className="text-xs text-text-muted font-mono uppercase tracking-wider mt-1">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Section 1 — How it works */}
        <div className="mt-16 pt-10 border-t border-border">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {steps.map((step) => (
              <div key={step.num} className="p-5 border border-border bg-bg-panel flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  {step.icon}
                  <span className="font-mono text-xs text-text-muted tracking-widest uppercase">
                    {step.num} · {step.label}
                  </span>
                </div>
                <p className="text-sm text-text-secondary font-mono leading-relaxed">{step.text}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Section 2 — FAQ accordion */}
        <div className="mt-16">
          <p className="font-mono text-xs text-text-muted uppercase tracking-widest mb-6">
            EARNING STRATEGIES — FAQ
          </p>
          <div>
            {faqs.map((item, i) => (
              <AccordionItem key={i} q={item.q} a={item.a} />
            ))}
            <div className="border-t border-border" />
          </div>
        </div>
      </div>

      {/* Section 3 — Disclaimer footer band */}
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
