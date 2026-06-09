'use client';

import Link from 'next/link';
import { Crosshair, Coins, Trophy, ArrowLeftRight, Zap, Landmark } from 'lucide-react';

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

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-bg-base">
      {/* Page header — chunk 4 will handle the global nav */}
      <header className="border-b border-border bg-bg-panel px-4 py-4 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-text-primary font-mono tracking-wide">ARBSCANNER</h1>
            <p className="text-xs text-text-muted font-mono">MULTI-STRATEGY ARBITRAGE PLATFORM</p>
          </div>
          <Link
            href="/"
            className="px-3 py-1.5 rounded border border-border text-text-secondary text-xs font-mono hover:border-accent/30 hover:text-text-primary transition-colors duration-100"
          >
            ← HOME
          </Link>
        </div>
      </header>

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
      </div>
    </div>
  );
}
