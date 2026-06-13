'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import TerminalHeader from '@/app/components/TerminalHeader';
import OpportunitiesPanel from '@/app/components/OpportunitiesPanel';

const stats = [
  { value: '14+',  label: 'AI AGENTS' },
  { value: '40+',  label: 'BOOKMAKERS' },
  { value: '12+',  label: 'PLATFORMS' },
  { value: '24/7', label: 'SCANNING' },
];

const strategies = [
  {
    tag: 'PREDICTION MARKETS',
    desc: 'Political, sports & current-events arb across Polymarket, Kalshi, PredictIt — AI-matched in real time.',
  },
  {
    tag: 'FUNDING RATE ARB',
    desc: 'Perpetual-to-spot divergence on Binance, Bybit, OKX — continuous yield from basis spread.',
  },
  {
    tag: 'SPORTS ARBITRAGE',
    desc: 'Surebets across 40+ bookmakers. Live odds re-checked every 30 s, auto-flagged on edge.',
  },
  {
    tag: 'CEX ARBITRAGE',
    desc: 'Cross-exchange price discrepancies with real-time depth analysis on major pairs.',
  },
  {
    tag: 'HFT 5-MIN',
    desc: 'High-frequency signals on Binance Futures. Sub-minute execution window, autonomous.',
  },
  {
    tag: 'LP STRATEGY',
    desc: 'Fee yield on Polymarket liquidity pools, calibrated by market volume and price dispersion.',
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-bg-base text-text-primary relative overflow-hidden">

      {/* Radial accent glow — barely visible */}
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
        <div
          className="absolute top-[-80px] left-1/2 -translate-x-1/2 w-[900px] h-[420px] rounded-full blur-[140px]"
          style={{ background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.06) 0%, transparent 70%)' }}
        />
      </div>

      {/* Grid background */}
      <div className="bg-grid-subtle pointer-events-none fixed inset-0 z-0 opacity-40" aria-hidden />

      {/* Shared terminal header */}
      <TerminalHeader />

      {/* ── Hero ──────────────────────────────────────────────── */}
      <main className="relative z-10 max-w-[1200px] mx-auto px-6 pt-20 pb-24">

        {/* Two-column hero: copy left, live panel right */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-10 xl:gap-14 items-start">

          {/* Left: copy */}
          <div>
            {/* Terminal tag */}
            <div className="mb-7">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted border border-border px-2.5 py-[5px]">
                MULTI-STRATEGY ARB PLATFORM
              </span>
            </div>

            {/* Headline */}
            <h1 className="font-sans font-semibold text-5xl md:text-[3.75rem] leading-[1.04] tracking-[-0.03em] text-text-primary mb-6 max-w-2xl">
              Precision<br />
              <span className="text-accent">arbitrage</span><br />
              intelligence.
            </h1>

            {/* Subhead */}
            <p className="text-text-secondary text-[15px] max-w-lg mb-10 leading-[1.65]">
              14 AI agents scan prediction markets, crypto exchanges, and sports books simultaneously.
              Surface edge. Execute faster.
            </p>

            {/* CTAs */}
            <div className="flex items-center gap-3 flex-wrap">
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent text-white font-mono font-medium text-[12px] uppercase tracking-[0.1em] transition-colors duration-100 hover:bg-accent-bright active:scale-[0.98]"
              >
                Open Terminal
                <ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />
              </Link>
              <Link
                href="/auth/login"
                className="inline-flex items-center gap-2 px-5 py-2.5 border border-border bg-bg-elevated text-text-secondary font-mono text-[12px] uppercase tracking-[0.1em] transition-colors duration-100 hover:border-accent/40 hover:text-text-primary"
              >
                Sign In
              </Link>
            </div>
          </div>

          {/* Right: live opportunities panel */}
          <div className="lg:pt-1">
            <OpportunitiesPanel />
          </div>

        </div>

        {/* ── Stats row ─────────────────────────────────────── */}
        <div className="mt-16 pt-6 border-t border-border grid grid-cols-2 md:grid-cols-4 gap-8">
          {stats.map(({ value, label }) => (
            <div key={label}>
              <div
                className={`font-mono font-bold text-[2rem] tabular-nums leading-none ${
                  label === 'SCANNING' ? 'text-accent' : 'text-text-primary'
                }`}
              >
                {value}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.13em] text-text-muted mt-2">
                {label}
              </div>
            </div>
          ))}
        </div>

        {/* ── Strategy grid ──────────────────────────────────── */}
        <div className="mt-20">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.15em] text-text-muted mb-4">
            ACTIVE STRATEGIES
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-border">
            {strategies.map(({ tag, desc }) => (
              <div
                key={tag}
                className="bg-bg-panel px-5 py-5 hover:bg-bg-elevated transition-colors duration-100 group"
              >
                <div className="font-mono text-[10px] uppercase tracking-[0.13em] text-accent mb-2.5">
                  {tag}
                </div>
                <p className="text-text-secondary text-[12px] leading-[1.6]">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-border">
        <div className="max-w-[1200px] mx-auto px-6 h-10 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-positive shrink-0" />
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
              ALL SYSTEMS OPERATIONAL
            </span>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            <span className="font-mono text-[10px] text-text-muted">v0.1.0</span>
            <span className="font-mono text-[10px] text-text-muted hidden sm:block">
              © 2026 ARBSCANNER
            </span>
          </div>
        </div>
      </footer>

    </div>
  );
}
