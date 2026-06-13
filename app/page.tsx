import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import TerminalHeader from '@/app/components/TerminalHeader';
import StrategyTicker from '@/app/components/StrategyTicker';

const stats = [
  { value: '4',   label: 'PREDICTION PLATFORMS' },
  { value: '4',   label: 'CRYPTO VENUES' },
  { value: '24/7', label: 'ALWAYS SCANNING' },
  { value: '60s',  label: 'DATA REFRESH' },
];

const strategies = [
  {
    tag:    'PREDICTION MARKETS',
    live:   true,
    desc:   'Binary outcome arb across PredictIt, Manifold, Kalshi, Polymarket. AI-matched by topic; best spread surfaced in real time.',
  },
  {
    tag:    'FUNDING RATE ARB',
    live:   true,
    desc:   'Cross-exchange perp funding spread — Binance, Bybit, OKX (8h) and Hyperliquid DEX (1h). Delta-neutral; net after fees.',
  },
  {
    tag:    'SPORTS ARBITRAGE',
    live:   false,
    desc:   'Surebets across major bookmakers via OddsAPI. Engine built and ready; live data feed disabled (cost control).',
  },
  {
    tag:    'CEX ARBITRAGE',
    live:   true,
    desc:   'Spot price divergence across Binance, Bybit, OKX on major pairs. Signals only — no current spread above threshold.',
  },
  {
    tag:    'HFT / 5-MIN',
    live:   false,
    desc:   'High-frequency signals on Binance Futures perps. Sub-minute execution window. Engine in development.',
  },
  {
    tag:    'LP / LIQUIDITY',
    live:   false,
    desc:   'Fee yield and LP opportunity scanning on Polymarket pools. Calibrated by volume and price dispersion. In development.',
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-bg-base text-text-primary relative overflow-hidden">

      {/* Radial accent glow */}
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
        <div
          className="absolute top-[-80px] left-1/2 -translate-x-1/2 w-[900px] h-[420px] rounded-full blur-[140px]"
          style={{ background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.06) 0%, transparent 70%)' }}
        />
      </div>

      {/* Grid background */}
      <div className="bg-grid-subtle pointer-events-none fixed inset-0 z-0 opacity-40" aria-hidden />

      <TerminalHeader />

      <main className="relative z-10 max-w-[1200px] mx-auto px-6 pt-20 pb-24">

        {/* ── Hero ────────────────────────────────────────────────────────────── */}
        <div className="mb-14">
          <div className="mb-7">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted border border-border px-2.5 py-[5px]">
              MULTI-STRATEGY SCANNER
            </span>
          </div>

          <h1 className="font-sans font-semibold text-5xl md:text-[3.75rem] leading-[1.04] tracking-[-0.03em] text-text-primary mb-5 max-w-2xl">
            Live arb &amp;<br />
            <span className="text-accent">funding</span><br />
            scanner.
          </h1>

          <p className="text-text-secondary text-[15px] max-w-xl mb-3 leading-[1.65]">
            ArbScanner surfaces live arbitrage and funding-rate opportunities across prediction markets,
            crypto perpetuals (CEX + Hyperliquid DEX), and sports.
            Returns shown are current snapshots — variable rates can flip at the next funding period.
          </p>
          <p className="font-mono text-[10px] text-text-muted/50 max-w-xl mb-9 leading-relaxed">
            Not financial advice. Returns are variable and not guaranteed.
            Do your own research before committing capital.
          </p>

          <div className="flex items-center gap-3 flex-wrap">
            <Link
              href="/dashboard/opportunities"
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent text-white font-mono font-medium text-[12px] uppercase tracking-[0.1em] transition-colors duration-100 hover:bg-accent-bright active:scale-[0.98]"
            >
              Live Opportunities
              <ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />
            </Link>
            <Link
              href="/dashboard/crypto"
              className="inline-flex items-center px-5 py-2.5 border border-border bg-bg-elevated text-text-secondary font-mono text-[12px] uppercase tracking-[0.1em] transition-colors duration-100 hover:border-accent/40 hover:text-text-primary"
            >
              Funding Monitor
            </Link>
          </div>
        </div>

        {/* ── Live strategy ticker ─────────────────────────────────────────────── */}
        <div className="mb-16">
          <div className="flex items-baseline justify-between mb-3 gap-4">
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-text-muted shrink-0">
              LIVE STRATEGY SNAPSHOT
            </span>
            <span className="font-mono text-[9px] text-text-muted/50 hidden sm:block">
              Best net opportunity per category · Click to explore
            </span>
          </div>
          <StrategyTicker />
          <p className="font-mono text-[9px] text-text-muted/40 mt-2 leading-relaxed">
            Numbers shown are the BEST live result per category — net after fees where applicable.
            Empty categories show a status word, never a fabricated figure. Refreshes every 30 s.
          </p>
        </div>

        {/* ── Stats row ────────────────────────────────────────────────────────── */}
        <div className="pt-6 border-t border-border grid grid-cols-2 md:grid-cols-4 gap-8 mb-16">
          {stats.map(({ value, label }) => (
            <div key={label}>
              <div className="font-mono font-bold text-[2rem] tabular-nums leading-none text-text-primary">
                {value}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.13em] text-text-muted mt-2">
                {label}
              </div>
            </div>
          ))}
        </div>

        {/* ── Strategy grid ────────────────────────────────────────────────────── */}
        <div>
          <h2 className="font-mono text-[10px] uppercase tracking-[0.15em] text-text-muted mb-4">
            ACTIVE STRATEGIES
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-border">
            {strategies.map(({ tag, live, desc }) => (
              <div
                key={tag}
                className="bg-bg-panel px-5 py-5 hover:bg-bg-elevated transition-colors duration-100"
              >
                <div className="flex items-center gap-2 mb-2.5">
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                      live ? 'bg-positive' : 'bg-text-muted/40'
                    }`}
                  />
                  <span className={`font-mono text-[10px] uppercase tracking-[0.13em] ${
                    live ? 'text-accent' : 'text-text-muted/60'
                  }`}>
                    {tag}
                  </span>
                </div>
                <p className="text-text-secondary text-[12px] leading-[1.6]">{desc}</p>
              </div>
            ))}
          </div>
        </div>

      </main>

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
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
