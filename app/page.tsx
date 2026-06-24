import TerminalHeader from '@/app/components/TerminalHeader';
import LandingHero from '@/app/components/LandingHero';
import LiveTickerBanner from '@/app/components/LiveTickerBanner';
import StrategyCards from '@/app/components/StrategyCards';
import Reveal from '@/app/components/Reveal';
import FooterStatus from '@/app/components/FooterStatus';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-bg-base text-text-primary relative overflow-hidden">

      {/* Radial accent glow */}
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
        <div
          className="absolute top-[-80px] left-1/2 -translate-x-1/2 w-[900px] h-[420px] rounded-full blur-[140px]"
          style={{ background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.09) 0%, transparent 70%)' }}
        />
      </div>
      <div className="bg-grid-subtle pointer-events-none fixed inset-0 z-0 opacity-40" aria-hidden />

      <TerminalHeader />

      {/* ── Live ticker — full-width scrolling strip ────────────────────────── */}
      <div className="relative z-10">
        <LiveTickerBanner />
      </div>

      <main className="relative z-10 max-w-[900px] mx-auto px-6 pt-10 pb-20">

        {/* ── 1. HERO ─────────────────────────────────────────────────────────── */}
        <LandingHero />

        {/* ── 2. STRATEGIES (each category once) ──────────────────────────────── */}
        <Reveal>
          <section className="mt-12 pt-8 border-t border-border/40">
            <div className="flex items-baseline justify-between mb-5 gap-4 flex-wrap">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-text-muted">
                STRATEGIES
              </span>
              <span className="font-mono text-[9px] text-text-muted/50 hidden sm:block">
                Multiple ways to find an edge. All monitored, all net of fees.
              </span>
            </div>
            <StrategyCards />
          </section>
        </Reveal>

        {/* ── 3. HOW IT WORKS ─────────────────────────────────────────────────── */}
        <Reveal delay={60}>
          <section className="mt-12 pt-8 border-t border-border/40">
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-text-muted block mb-5">
              HOW IT WORKS
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-3 border border-border overflow-hidden">
              {([
                {
                  step:  '01',
                  title: 'Scan',
                  body:  'Agents watch Polymarket, Kalshi, Bybit, OKX, Dydx, and Deribit continuously — prices and funding rates pulled every 60 s.',
                },
                {
                  step:  '02',
                  title: 'Rank',
                  body:  'Every opportunity is net-of-fees before it appears. Best result per category surfaced automatically, ranked by real yield.',
                },
                {
                  step:  '03',
                  title: 'Decide',
                  body:  'You act on what you see, or wait for an alert (Pro — coming soon). Nothing is automated on your behalf.',
                },
              ] as const).map((s, i) => (
                <div
                  key={s.step}
                  className={`bg-bg-panel px-5 py-5 ${i < 2 ? 'border-b sm:border-b-0 sm:border-r border-border' : ''}`}
                >
                  <div className="font-mono text-[9px] text-text-muted/40 mb-1.5">{s.step}</div>
                  <div className="font-mono text-[12px] text-text-primary font-semibold mb-2">{s.title}</div>
                  <p className="font-mono text-[10px] text-text-muted leading-relaxed">{s.body}</p>
                </div>
              ))}
            </div>
          </section>
        </Reveal>

        {/* ── 4. PLANS ────────────────────────────────────────────────────────── */}
        <Reveal delay={80}>
          <section className="mt-12 pt-8 border-t border-border/40">
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-text-muted block mb-5">
              PLANS
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-3 border border-border overflow-hidden">

              {/* FREE */}
              <div className="bg-bg-panel px-5 py-5 flex flex-col border-b sm:border-b-0 sm:border-r border-border">
                <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-1.5">FREE</div>
                <div className="mb-0.5">
                  <span className="font-mono text-[20px] font-bold text-text-primary">€0</span>
                </div>
                <div className="font-mono text-[9px] text-text-muted/60 mb-4">always</div>
                <ul className="space-y-2 flex-1">
                  {['All strategy pages, live', 'Funding rate monitor', 'Full opportunity list', 'Basic Telegram alerts', 'No account needed'].map(f => (
                    <li key={f} className="flex items-start gap-1.5">
                      <span className="text-positive font-mono text-[10px] mt-px leading-none">✓</span>
                      <span className="font-mono text-[10px] text-text-secondary leading-snug">{f}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-5">
                  <span className="inline-block font-mono text-[9px] uppercase tracking-widest px-3.5 py-1.5 border border-border text-text-muted/50 cursor-default">
                    Current plan
                  </span>
                </div>
              </div>

              {/* PRO */}
              <div className="bg-bg-panel px-5 py-5 flex flex-col relative border-b sm:border-b-0 sm:border-r border-border">
                <div className="absolute top-0 left-0 right-0 h-[2px] bg-accent" />
                <div className="font-mono text-[9px] uppercase tracking-widest text-accent mb-1.5">PRO</div>
                <div className="mb-0.5">
                  <span className="font-mono text-[20px] font-bold text-text-primary">€15</span>
                  <span className="font-mono text-[11px] font-normal text-text-muted">/mo</span>
                </div>
                <div className="font-mono text-[9px] text-text-muted/60 mb-4">billed monthly</div>
                <ul className="space-y-2 flex-1">
                  {['Email alerts + priority Telegram (all strategies)', 'Kelly position sizing', 'Opportunity history log', 'Priority data refresh'].map(f => (
                    <li key={f} className="flex items-start gap-1.5">
                      <span className="text-accent font-mono text-[10px] mt-px leading-none">✓</span>
                      <span className="font-mono text-[10px] text-text-secondary leading-snug">{f}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-5">
                  <span className="inline-block font-mono text-[9px] uppercase tracking-widest px-3.5 py-1.5 border border-border/50 text-text-muted/50 cursor-default">
                    Coming soon
                  </span>
                </div>
              </div>

              {/* PROFIT SHARE */}
              <div className="bg-bg-panel px-5 py-5 flex flex-col">
                <div className="font-mono text-[9px] uppercase tracking-widest text-text-muted mb-1.5">PROFIT SHARE</div>
                <div className="mb-0.5">
                  <span className="font-mono text-[20px] font-bold text-text-primary">€0</span>
                  <span className="font-mono text-[11px] font-normal text-text-muted"> + 10%</span>
                </div>
                <div className="font-mono text-[9px] text-text-muted/60 mb-4">of verified profits</div>
                <ul className="space-y-2 flex-1">
                  {['Everything in Pro', 'Pay only when you profit', 'On-chain verification', 'No monthly risk'].map(f => (
                    <li key={f} className="flex items-start gap-1.5">
                      <span className="text-text-muted/60 font-mono text-[10px] mt-px leading-none">✓</span>
                      <span className="font-mono text-[10px] text-text-secondary leading-snug">{f}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-5">
                  <span className="inline-block font-mono text-[9px] uppercase tracking-widest px-3.5 py-1.5 border border-border/50 text-text-muted/50 cursor-default">
                    Coming soon
                  </span>
                </div>
              </div>

            </div>
            <p className="font-mono text-[9px] text-text-muted/40 mt-3 leading-relaxed">
              Payments not yet wired. Dashboard is fully open — no login required.
              Plans shown are the intended roadmap, not a live gate.
            </p>
          </section>
        </Reveal>

      </main>

      {/* ── 5. FOOTER ───────────────────────────────────────────────────────── */}
      <footer className="relative z-10 border-t border-border">
        <div className="max-w-[900px] mx-auto px-6 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <FooterStatus />
          <div className="flex items-center gap-4 flex-wrap">
            <span className="font-mono text-[9px] text-text-muted/50">Not financial advice. Capital at risk.</span>
            <span className="font-mono text-[10px] text-text-muted">v0.1.0</span>
            <span className="font-mono text-[10px] text-text-muted hidden sm:block">© 2026 ARBSCANNER</span>
          </div>
        </div>
      </footer>

    </div>
  );
}
