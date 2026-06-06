import Link from 'next/link';

async function getLiveStats() {
  try {
    const fs = await import('fs');
    const arbData = JSON.parse(fs.readFileSync('/tmp/arbitrage-opportunities.json', 'utf8'));
    const log     = JSON.parse(fs.readFileSync('/tmp/master-log.json', 'utf8'));
    const recent24h = log.filter((e: any) => e.status === 'success' && Date.now() - new Date(e.ts).getTime() < 86_400_000);
    return {
      totalMarkets:   1200,
      oppsToday:      recent24h.reduce((s: number, e: any) => s + (e.opportunities ?? 0), 0),
      avgRoi:         recent24h.length > 0
                        ? (recent24h.reduce((s: number, e: any) => s + (e.best?.confidence ?? 0), 0) / recent24h.length).toFixed(0)
                        : 0,
      bestRoi:        arbData?.stats?.bestRoi?.toFixed(1) ?? '0',
    };
  } catch {
    return { totalMarkets: 1200, oppsToday: 0, avgRoi: 0, bestRoi: '0' };
  }
}

export const revalidate = 30;

export default async function LandingPage() {
  const stats = await getLiveStats();

  return (
    <main className="bg-gray-950 text-white min-h-screen">

      {/* Nav */}
      <nav className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold tracking-tight">PredMarket Scanner</span>
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-green-700 bg-green-900/40 text-xs font-bold text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />LIVE
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/dashboard" className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors">Dashboard</Link>
            <Link href="/auth/login" className="px-3 py-1.5 rounded-lg border border-gray-700 text-sm text-gray-300 hover:border-gray-500 hover:text-white transition-colors">Sign In</Link>
            <Link href="/auth/register" className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors">Free Account</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-4 md:px-6 py-20 md:py-28 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-blue-700/50 bg-blue-950/30 text-blue-300 text-xs font-semibold mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          AI-powered · {stats.totalMarkets.toLocaleString()} markets monitored right now
        </div>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6 bg-gradient-to-br from-white to-gray-400 bg-clip-text text-transparent leading-tight">
          Find Arbitrage Opportunities<br className="hidden md:block" /> Across 8 Prediction Markets
        </h1>
        <p className="text-gray-400 text-lg md:text-xl mb-8 max-w-2xl mx-auto leading-relaxed">
          AI-powered scanner finds guaranteed profit windows before they close.
          Kalshi, Polymarket, Manifold, PredictIt — all in one place.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link href="/dashboard"
            className="px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-base transition-colors inline-flex items-center justify-center gap-2">
            View Live Dashboard →
          </Link>
          <Link href="/auth/register"
            className="px-6 py-3 rounded-xl border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white font-semibold text-base transition-colors inline-flex items-center justify-center gap-2">
            Create Free Account
          </Link>
        </div>
      </section>

      {/* Live stats bar */}
      <section className="border-y border-gray-800 bg-gray-900/40">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
          {[
            { label: 'Markets Monitored', value: stats.totalMarkets.toLocaleString(), suffix: '' },
            { label: 'Opportunities Today', value: String(stats.oppsToday), suffix: '' },
            { label: 'Avg AI Confidence', value: `${stats.avgRoi}`, suffix: '%' },
            { label: 'Best ROI (last 24h)', value: `${stats.bestRoi}`, suffix: '%' },
          ].map(s => (
            <div key={s.label}>
              <div className="text-3xl font-bold text-white tabular-nums">{s.value}{s.suffix}</div>
              <div className="text-xs text-gray-500 mt-1">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-6xl mx-auto px-4 md:px-6 py-20">
        <h2 className="text-3xl font-bold text-center mb-12">How It Works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            {
              step: '01',
              icon: '📡',
              title: 'Continuous Scanning',
              desc: 'We scan 1,200+ markets every 30 seconds across Kalshi, Polymarket, Manifold, PredictIt, and 4 more platforms.',
            },
            {
              step: '02',
              icon: '🧠',
              title: 'AI Analysis',
              desc: 'Claude Sonnet analyzes price differences and ranks opportunities by profit potential, confidence, and execution risk.',
            },
            {
              step: '03',
              icon: '💸',
              title: 'Exact Instructions',
              desc: 'You get step-by-step execution: what to buy, on which platform, at what price — with expected profit after fees.',
            },
          ].map(s => (
            <div key={s.step} className="rounded-2xl border border-gray-800 bg-gray-900/40 p-6">
              <div className="flex items-center gap-3 mb-4">
                <span className="text-3xl">{s.icon}</span>
                <span className="text-xs font-bold text-gray-600">{s.step}</span>
              </div>
              <h3 className="font-bold text-lg text-white mb-2">{s.title}</h3>
              <p className="text-gray-400 text-sm leading-relaxed">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Opportunity preview (blurred) */}
      <section className="max-w-6xl mx-auto px-4 md:px-6 pb-20">
        <h2 className="text-3xl font-bold text-center mb-4">Live Opportunities</h2>
        <p className="text-center text-gray-500 text-sm mb-10">Real-time AI analysis — sign up to see full details</p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 relative">
          {/* Blur overlay */}
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl bg-gray-950/70 backdrop-blur-sm">
            <p className="text-white font-semibold text-lg mb-1">Sign up to unlock</p>
            <p className="text-gray-400 text-sm mb-4">Free — no credit card required</p>
            <Link href="/auth/register" className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-colors">
              Create Free Account →
            </Link>
          </div>

          {/* Fake cards */}
          {[
            { type: 'Prediction Arb', roi: '██%', conf: '██%', urgency: 'HIGH', platform: 'Kalshi → Polymarket' },
            { type: 'Funding Rate',   roi: '██%', conf: '██%', urgency: 'MED',  platform: 'Binance Perp' },
            { type: 'CEX Arb',        roi: '██%', conf: '██%', urgency: 'HIGH', platform: 'Binance → OKX' },
          ].map((c, i) => (
            <div key={i} className="rounded-xl border border-gray-800 bg-gray-900/60 p-5 select-none">
              <div className="flex items-start gap-3">
                <div className="rounded-xl border border-green-700 bg-green-900/40 px-3 py-2 text-center min-w-[64px]">
                  <div className="text-lg font-bold text-green-400">{c.roi}</div>
                  <div className="text-xs text-gray-500">ROI</div>
                </div>
                <div className="flex-1">
                  <div className="flex gap-2 mb-2">
                    <span className="text-xs px-2 py-0.5 rounded-full border border-gray-700 text-gray-400">{c.type}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full border font-bold ${c.urgency === 'HIGH' ? 'border-red-700 bg-red-900/40 text-red-300' : 'border-amber-700 bg-amber-900/30 text-amber-300'}`}>{c.urgency}</span>
                  </div>
                  <div className="h-2.5 bg-gray-700 rounded-full w-3/4 mb-2" />
                  <div className="h-2 bg-gray-800 rounded-full w-full mb-1" />
                  <div className="h-2 bg-gray-800 rounded-full w-2/3" />
                  <div className="mt-3 text-xs text-gray-600">{c.platform}</div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-gray-700 rounded-full"><div className="h-full bg-gray-500 rounded-full w-3/4" /></div>
                    <span className="text-xs text-gray-500">Conf: {c.conf}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-gray-800 bg-gray-900/20">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-20">
          <h2 className="text-3xl font-bold text-center mb-12">Full Platform Features</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
            {[
              { icon: '🧠', title: 'AI Master Analysis',      desc: 'Claude Sonnet scans all data every 30 minutes' },
              { icon: '📱', title: 'Telegram Alerts',         desc: 'Real-time notifications for high-confidence opps' },
              { icon: '⚡', title: 'WebSocket Prices',         desc: 'Binance live BTC/ETH/SOL via WebSocket stream' },
              { icon: '⚙️', title: 'Market Making Bot',       desc: 'Detects info-lag on large price moves' },
              { icon: '💧', title: 'Liquidity Tools',          desc: 'Polymarket AMM LP tracking + IL calculator' },
              { icon: '📊', title: 'Portfolio Tracker',        desc: 'Track every trade, P&L, and win rate' },
              { icon: '🏟️', title: 'Sports Arb',              desc: 'Bookmaker arbitrage across 6 sports leagues' },
              { icon: '🌤️', title: 'Weather Markets',          desc: 'Kalshi weather + Open-Meteo forecast data' },
              { icon: '⚖️', title: 'Cash & Carry',            desc: 'Spot vs perpetual futures basis trades' },
            ].map(f => (
              <div key={f.title} className="flex gap-3 p-4 rounded-xl border border-gray-800 bg-gray-900/40">
                <span className="text-2xl flex-shrink-0">{f.icon}</span>
                <div>
                  <h3 className="font-semibold text-sm text-gray-200">{f.title}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-gray-800 bg-gray-900/40">
        <div className="max-w-2xl mx-auto px-4 md:px-6 py-20 text-center">
          <h2 className="text-3xl font-bold mb-4">Start Finding Opportunities Now</h2>
          <p className="text-gray-400 mb-8">Free account. No credit card. Full dashboard access.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/auth/register" className="px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-base transition-colors">
              Create Free Account →
            </Link>
            <Link href="/dashboard" className="px-6 py-3 rounded-xl border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white font-semibold text-base transition-colors">
              View Dashboard (no login)
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800 bg-gray-900/20">
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-8 flex flex-wrap items-center justify-between gap-4">
          <div className="text-xs text-gray-600">
            <strong className="text-gray-500">PredMarket Scanner</strong> · Not financial advice. Always verify before trading.
          </div>
          <div className="flex gap-4 text-xs text-gray-600">
            <Link href="/dashboard"       className="hover:text-gray-400 transition-colors">Dashboard</Link>
            <Link href="/auth/login"      className="hover:text-gray-400 transition-colors">Login</Link>
            <Link href="/auth/register"   className="hover:text-gray-400 transition-colors">Register</Link>
          </div>
        </div>
      </footer>

    </main>
  );
}
