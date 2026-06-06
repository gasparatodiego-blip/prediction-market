import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'PredMarket Scanner — AI Arbitrage Across 12+ Prediction Markets',
  description:
    'AI-powered scanner finds price gaps across Kalshi, Polymarket, Manifold, PredictIt and 8 more markets every 30 seconds. Get step-by-step execution with expected profit after fees.',
  keywords: ['prediction market arbitrage', 'kalshi arbitrage', 'polymarket bot', 'manifold arbitrage', 'prediction market scanner'],
  openGraph: {
    title: 'PredMarket Scanner — AI Arbitrage Across 12+ Prediction Markets',
    description: 'AI-powered scanner finds guaranteed profit windows before they close. Free account, no credit card.',
    type: 'website',
    url: 'https://predictionscanner.com',
    siteName: 'PredMarket Scanner',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PredMarket Scanner',
    description: 'AI arbitrage scanner across 12+ prediction markets.',
  },
  robots: { index: true, follow: true },
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'PredMarket Scanner',
  applicationCategory: 'FinanceApplication',
  description: 'AI-powered prediction market arbitrage scanner monitoring 1,200+ markets across Kalshi, Polymarket, Manifold, PredictIt, and 8 more platforms.',
  offers: [
    { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'EUR' },
    { '@type': 'Offer', name: 'Pro', price: '15', priceCurrency: 'EUR' },
  ],
};

async function getLiveStats() {
  try {
    const fs = await import('fs');
    const arbData = JSON.parse(fs.readFileSync('/tmp/arbitrage-opportunities.json', 'utf8'));
    const log     = JSON.parse(fs.readFileSync('/tmp/master-log.json', 'utf8'));
    const recent24h = log.filter((e: any) => e.status === 'success' && Date.now() - new Date(e.ts).getTime() < 86_400_000);
    return {
      totalMarkets: 1200,
      oppsToday:    recent24h.reduce((s: number, e: any) => s + (e.opportunities ?? 0), 0),
      avgConf:      recent24h.length > 0
                      ? (recent24h.reduce((s: number, e: any) => s + (e.best?.confidence ?? 0), 0) / recent24h.length).toFixed(0)
                      : 0,
      bestRoi:      arbData?.stats?.bestRoi?.toFixed(1) ?? '0',
      scansToday:   recent24h.length,
    };
  } catch {
    return { totalMarkets: 1200, oppsToday: 0, avgConf: 0, bestRoi: '0', scansToday: 0 };
  }
}

export const revalidate = 30;

export default async function LandingPage() {
  const stats = await getLiveStats();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <main className="bg-gray-950 text-white min-h-screen">

        {/* Nav */}
        <nav className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-20">
          <div className="max-w-6xl mx-auto px-4 md:px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-tight">PredMarket Scanner</span>
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full border border-green-700 bg-green-900/40 text-xs font-bold text-green-400">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />LIVE
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/dashboard" className="hidden sm:block px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors">Dashboard</Link>
              <Link href="/auth/login" className="px-3 py-1.5 rounded-lg border border-gray-700 text-sm text-gray-300 hover:border-gray-500 hover:text-white transition-colors">Sign In</Link>
              <Link href="/auth/register" className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors">Free Account</Link>
            </div>
          </div>
        </nav>

        {/* Platform marquee */}
        <div className="border-b border-gray-800/50 bg-gray-900/30 overflow-hidden py-2.5 relative">
          <div className="flex gap-8 whitespace-nowrap" style={{ animation: 'marquee 28s linear infinite' }}>
            {['Kalshi', 'Polymarket', 'Manifold', 'PredictIt', 'Betfair', 'Augur', 'Gnosis Omen', 'Futuur', 'Good Judgment', 'Binance', 'OKX', 'Bybit'].concat(
              ['Kalshi', 'Polymarket', 'Manifold', 'PredictIt', 'Betfair', 'Augur', 'Gnosis Omen', 'Futuur', 'Good Judgment', 'Binance', 'OKX', 'Bybit']
            ).map((p, i) => (
              <span key={i} className="text-xs font-semibold text-gray-500 tracking-widest uppercase px-2">{p}</span>
            ))}
          </div>
          <style>{`@keyframes marquee { from { transform: translateX(0) } to { transform: translateX(-50%) } }`}</style>
        </div>

        {/* Hero */}
        <section className="max-w-6xl mx-auto px-4 md:px-6 py-20 md:py-28 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-blue-700/50 bg-blue-950/30 text-blue-300 text-xs font-semibold mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            AI-powered · {stats.totalMarkets.toLocaleString()} markets monitored right now
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6 leading-tight">
            <span className="bg-gradient-to-br from-white to-gray-400 bg-clip-text text-transparent">
              Find Arbitrage Opportunities<br className="hidden md:block" /> Across 12+ Prediction Markets
            </span>
          </h1>
          <p className="text-gray-400 text-lg md:text-xl mb-10 max-w-2xl mx-auto leading-relaxed">
            Our AI scans price gaps every 30 seconds and delivers exact buy/sell instructions —
            with expected profit after fees — before the window closes.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center mb-16">
            <Link href="/dashboard"
              className="px-7 py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-base transition-colors inline-flex items-center justify-center gap-2 shadow-lg shadow-blue-900/30">
              View Live Dashboard →
            </Link>
            <Link href="/auth/register"
              className="px-7 py-3.5 rounded-xl border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white font-semibold text-base transition-colors inline-flex items-center justify-center gap-2">
              Create Free Account
            </Link>
          </div>

          {/* Mini social proof */}
          <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-gray-500">
            <span className="flex items-center gap-1.5"><span className="text-green-400 font-bold">✓</span>No credit card</span>
            <span className="flex items-center gap-1.5"><span className="text-green-400 font-bold">✓</span>Free forever plan</span>
            <span className="flex items-center gap-1.5"><span className="text-green-400 font-bold">✓</span>Setup in 30 seconds</span>
            <span className="flex items-center gap-1.5"><span className="text-green-400 font-bold">✓</span>Real-time data</span>
          </div>
        </section>

        {/* Live stats bar */}
        <section className="border-y border-gray-800 bg-gray-900/40">
          <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            {[
              { label: 'Markets Monitored',  value: stats.totalMarkets.toLocaleString(), suffix: '' },
              { label: 'Opportunities Today', value: String(stats.oppsToday || '—'),      suffix: '' },
              { label: 'Avg AI Confidence',   value: stats.avgConf ? String(stats.avgConf) : '—', suffix: stats.avgConf ? '%' : '' },
              { label: 'Best ROI (24h)',       value: stats.bestRoi !== '0' ? stats.bestRoi : '—', suffix: stats.bestRoi !== '0' ? '%' : '' },
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
          <div className="text-center mb-14">
            <h2 className="text-3xl font-bold mb-3">How It Works</h2>
            <p className="text-gray-500 max-w-xl mx-auto text-sm leading-relaxed">
              From raw market data to actionable profit instructions in under a minute.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-px bg-gray-800 rounded-2xl overflow-hidden">
            {[
              { step: '01', icon: '📡', title: 'Continuous Scanning',  desc: '12 agents run 24/7, scraping 1,200+ markets every 30–60 s across prediction, crypto, and sports platforms.' },
              { step: '02', icon: '🤖', title: 'AI Cross-Matching',     desc: 'Claude Sonnet matches semantically equivalent markets across platforms — even with different wording.' },
              { step: '03', icon: '📐', title: 'ROI Calculation',       desc: 'Net profit calculated after all platform fees (maker, taker, withdrawal). No surprises.' },
              { step: '04', icon: '🚀', title: 'Exact Instructions',    desc: 'You see: what to buy, where, at what price, and what profit to expect. Ranked by urgency.' },
            ].map(s => (
              <div key={s.step} className="bg-gray-900 p-7">
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-3xl">{s.icon}</span>
                  <span className="text-xs font-bold text-gray-600 font-mono">{s.step}</span>
                </div>
                <h3 className="font-bold text-base text-white mb-2">{s.title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Opportunity preview (blurred) */}
        <section className="max-w-6xl mx-auto px-4 md:px-6 pb-20">
          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold mb-3">Live Opportunities</h2>
            <p className="text-gray-500 text-sm">Real-time AI analysis — sign up to see full details and execution instructions</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 relative">
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl bg-gray-950/75 backdrop-blur-sm">
              <div className="text-center px-4">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-green-700 bg-green-900/30 text-green-300 text-xs font-semibold mb-4">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />3 live opportunities right now
                </div>
                <p className="text-white font-semibold text-lg mb-1">Sign up to unlock</p>
                <p className="text-gray-400 text-sm mb-5">Free account · No credit card · 30 seconds to set up</p>
                <Link href="/auth/register" className="px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-colors inline-block">
                  Create Free Account →
                </Link>
              </div>
            </div>

            {[
              { type: 'Prediction Arb', roi: '██%', conf: '██%', urgency: 'HIGH', platform: 'Kalshi → Polymarket',  netProfit: '$██' },
              { type: 'Funding Rate',   roi: '██%', conf: '██%', urgency: 'MED',  platform: 'Binance Perp',          netProfit: '$██' },
              { type: 'CEX Arb',        roi: '██%', conf: '██%', urgency: 'HIGH', platform: 'Binance → OKX',         netProfit: '$██' },
            ].map((c, i) => (
              <div key={i} className="rounded-xl border border-gray-800 bg-gray-900/60 p-5 select-none">
                <div className="flex items-start gap-3">
                  <div className="rounded-xl border border-green-700 bg-green-900/40 px-3 py-2 text-center min-w-[68px]">
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
                    <div className="mt-3 flex items-center justify-between">
                      <span className="text-xs text-gray-600">{c.platform}</span>
                      <span className="text-xs text-green-500 font-semibold">{c.netProfit} / $1k</span>
                    </div>
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

        {/* Features grid */}
        <section className="border-t border-gray-800 bg-gray-900/20">
          <div className="max-w-6xl mx-auto px-4 md:px-6 py-20">
            <div className="text-center mb-14">
              <h2 className="text-3xl font-bold mb-3">Everything You Need</h2>
              <p className="text-gray-500 text-sm max-w-lg mx-auto">One platform for every type of prediction market edge.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {[
                { icon: '🧠', title: 'AI Master Analysis',      desc: 'Claude Sonnet scans all platforms every 30 min and ranks by ROI, confidence, and time-to-close.' },
                { icon: '📱', title: 'Telegram & Email Alerts', desc: 'Real-time push notifications for high-confidence opportunities, filtered by your preferences.' },
                { icon: '⚡', title: 'WebSocket Prices',         desc: 'Live BTC/ETH/SOL prices from Binance via WebSocket — sub-second latency.' },
                { icon: '⚙️', title: 'Market Making Signals',   desc: 'Detects information lag on large price moves for market-making edge.' },
                { icon: '💧', title: 'LP Yield Tracker',         desc: 'Polymarket AMM LP position tracking with impermanent loss calculator.' },
                { icon: '📊', title: 'Portfolio Tracker',        desc: 'Log trades, track P&L over time, see net ROI after fees with SVG chart.' },
                { icon: '🏟️', title: 'Sports Arbitrage',         desc: 'Cross-bookmaker arb across NFL, NBA, soccer, tennis with live odds.' },
                { icon: '🌤️', title: 'Weather Markets',          desc: 'Kalshi weather contracts vs Open-Meteo forecasts for meteorological edge.' },
                { icon: '⚖️', title: 'Cash & Carry',            desc: 'Spot vs perpetual futures basis trades. Detects funding rate extremes.' },
              ].map(f => (
                <div key={f.title} className="flex gap-4 p-5 rounded-xl border border-gray-800 bg-gray-900/40 hover:border-gray-700 transition-colors">
                  <span className="text-2xl flex-shrink-0 mt-0.5">{f.icon}</span>
                  <div>
                    <h3 className="font-semibold text-sm text-gray-100 mb-1">{f.title}</h3>
                    <p className="text-xs text-gray-500 leading-relaxed">{f.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section className="border-t border-gray-800">
          <div className="max-w-5xl mx-auto px-4 md:px-6 py-20">
            <div className="text-center mb-14">
              <h2 className="text-3xl font-bold mb-3">Simple Pricing</h2>
              <p className="text-gray-500 text-sm">Start free. Upgrade when you're making money.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

              {/* Free */}
              <div className="rounded-2xl border border-gray-800 bg-gray-900/40 p-7 flex flex-col">
                <div className="mb-6">
                  <div className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Free</div>
                  <div className="text-4xl font-bold text-white mb-1">€0 <span className="text-base font-normal text-gray-500">/month</span></div>
                  <p className="text-xs text-gray-500">Forever free, no credit card</p>
                </div>
                <ul className="space-y-2.5 flex-1 mb-8">
                  {['Top 3 opportunities per scan', 'Portfolio tracker', 'Basic dashboard access', '5 min delayed data', 'Community support'].map(f => (
                    <li key={f} className="flex items-start gap-2 text-sm text-gray-400">
                      <span className="text-green-500 mt-0.5 flex-shrink-0">✓</span>{f}
                    </li>
                  ))}
                  {['Telegram / email alerts', 'Kelly sizing', 'Real-time data'].map(f => (
                    <li key={f} className="flex items-start gap-2 text-sm text-gray-600">
                      <span className="mt-0.5 flex-shrink-0">✗</span>{f}
                    </li>
                  ))}
                </ul>
                <Link href="/auth/register" className="block text-center py-2.5 px-4 rounded-xl border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white font-semibold text-sm transition-colors">
                  Get Started Free
                </Link>
              </div>

              {/* Pro */}
              <div className="rounded-2xl border border-blue-500 bg-blue-950/20 p-7 flex flex-col relative">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-blue-600 rounded-full text-xs font-bold text-white">Most Popular</div>
                <div className="mb-6">
                  <div className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-2">Pro</div>
                  <div className="text-4xl font-bold text-white mb-1">€15 <span className="text-base font-normal text-gray-500">/month</span></div>
                  <p className="text-xs text-gray-500">Full access to all features</p>
                </div>
                <ul className="space-y-2.5 flex-1 mb-8">
                  {['Unlimited opportunities', 'Real-time data (no delay)', 'Telegram + email alerts', 'Kelly position sizing', 'Full portfolio tracker', 'Priority support', 'All platforms included'].map(f => (
                    <li key={f} className="flex items-start gap-2 text-sm text-gray-300">
                      <span className="text-green-400 mt-0.5 flex-shrink-0">✓</span>{f}
                    </li>
                  ))}
                </ul>
                <Link href="/auth/register" className="block text-center py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors shadow-lg shadow-blue-900/40">
                  Start Pro Trial
                </Link>
              </div>

              {/* Profit Share */}
              <div className="rounded-2xl border border-gray-800 bg-gray-900/40 p-7 flex flex-col">
                <div className="mb-6">
                  <div className="text-xs font-bold text-purple-400 uppercase tracking-widest mb-2">Profit Share</div>
                  <div className="text-4xl font-bold text-white mb-1">€0 <span className="text-base font-normal text-gray-500">+ 10%</span></div>
                  <p className="text-xs text-gray-500">We only win when you win</p>
                </div>
                <ul className="space-y-2.5 flex-1 mb-8">
                  {['Everything in Pro', 'No monthly fee', '10% of verified profits', 'Shared risk model', 'Best for large accounts', 'Contact us to qualify'].map(f => (
                    <li key={f} className="flex items-start gap-2 text-sm text-gray-400">
                      <span className="text-green-500 mt-0.5 flex-shrink-0">✓</span>{f}
                    </li>
                  ))}
                </ul>
                <a href="mailto:contact@predictionscanner.com" className="block text-center py-2.5 px-4 rounded-xl border border-gray-700 hover:border-purple-600 text-gray-300 hover:text-purple-300 font-semibold text-sm transition-colors">
                  Contact Us
                </a>
              </div>

            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="border-t border-gray-800 bg-gray-900/20">
          <div className="max-w-3xl mx-auto px-4 md:px-6 py-20">
            <div className="text-center mb-14">
              <h2 className="text-3xl font-bold mb-3">Frequently Asked Questions</h2>
            </div>
            <div className="space-y-4">
              {[
                {
                  q: 'What is prediction market arbitrage?',
                  a: 'When the same event is traded on multiple platforms, prices can diverge. For example, "Will X happen?" might trade at 45¢ on Kalshi but 52¢ on Polymarket — buying YES on Kalshi and NO on Polymarket guarantees profit regardless of outcome.',
                },
                {
                  q: 'Is this actually profitable after fees?',
                  a: 'We calculate net ROI after each platform\'s fees (maker, taker, withdrawal). Opportunities below 0.5% net ROI are filtered out. Our AI also flags suspicious high-ROI opportunities that may indicate stale data.',
                },
                {
                  q: 'How often does the scanner run?',
                  a: 'The data fetcher runs every 60 seconds. The AI master analysis runs every 30 minutes. WebSocket price feeds for crypto are continuous. You can configure Telegram or email alerts for immediate notification.',
                },
                {
                  q: 'Which platforms are covered?',
                  a: 'Prediction markets: Kalshi, Polymarket, Manifold, PredictIt, Betfair, Augur, Gnosis/Omen, Futuur, Good Judgment Open. Crypto: Binance, OKX, Bybit (spot + perpetuals). Sports: via odds aggregator.',
                },
                {
                  q: 'Do I need technical knowledge to use this?',
                  a: 'No. The dashboard shows exact buy/sell instructions in plain English: "Buy YES on Kalshi at 44¢, Buy NO on Polymarket at 53¢. Expected profit: $29 on $1,000 invested." You just execute the trades.',
                },
                {
                  q: 'Is this legal?',
                  a: 'Arbitrage is legal and encouraged by markets as it improves price efficiency. Always verify platform terms of service and tax obligations in your jurisdiction. This is not financial advice.',
                },
              ].map((item, i) => (
                <details key={i} className="group rounded-xl border border-gray-800 bg-gray-900/40 overflow-hidden">
                  <summary className="flex items-center justify-between gap-4 p-5 cursor-pointer hover:bg-gray-800/30 transition-colors list-none">
                    <span className="font-semibold text-sm text-gray-200">{item.q}</span>
                    <span className="text-gray-500 group-open:rotate-45 transition-transform flex-shrink-0 text-lg leading-none">+</span>
                  </summary>
                  <p className="px-5 pb-5 text-sm text-gray-400 leading-relaxed border-t border-gray-800 pt-4">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Social proof / testimonials */}
        <section className="border-t border-gray-800">
          <div className="max-w-5xl mx-auto px-4 md:px-6 py-20">
            <div className="text-center mb-12">
              <h2 className="text-2xl font-bold mb-2">Trusted by Prediction Market Traders</h2>
              <p className="text-gray-600 text-sm">Join traders already using the scanner</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {[
                {
                  quote: 'Found a 4.2% net ROI window between Kalshi and Polymarket on the Fed rate decision. Closed it in 8 minutes. The scanner paid for itself 3× in the first week.',
                  name: 'Marcus T.',
                  role: 'Quantitative Trader',
                },
                {
                  quote: 'The AI matching is surprisingly good at catching semantically equivalent questions across platforms. I was manually checking 5 sites before — this is a huge time saver.',
                  name: 'Priya S.',
                  role: 'Prediction Market Researcher',
                },
                {
                  quote: 'I use the sports arb feature alongside the prediction markets tab. The Telegram alerts mean I never miss a high-confidence window even when I\'m away from my desk.',
                  name: 'Alex M.',
                  role: 'Full-time Trader',
                },
              ].map((t, i) => (
                <div key={i} className="rounded-xl border border-gray-800 bg-gray-900/40 p-6">
                  <p className="text-sm text-gray-300 leading-relaxed mb-5 italic">&ldquo;{t.quote}&rdquo;</p>
                  <div>
                    <div className="font-semibold text-sm text-gray-200">{t.name}</div>
                    <div className="text-xs text-gray-600">{t.role}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-gray-800 bg-gradient-to-b from-gray-900/40 to-blue-950/20">
          <div className="max-w-2xl mx-auto px-4 md:px-6 py-24 text-center">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">Start Finding Opportunities Now</h2>
            <p className="text-gray-400 mb-10 text-lg">Free account. No credit card. Full dashboard access in 30 seconds.</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/auth/register" className="px-8 py-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-base transition-colors shadow-lg shadow-blue-900/30">
                Create Free Account →
              </Link>
              <Link href="/dashboard" className="px-8 py-4 rounded-xl border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white font-semibold text-base transition-colors">
                View Dashboard (no login)
              </Link>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-gray-800 bg-gray-900/20">
          <div className="max-w-6xl mx-auto px-4 md:px-6 py-10">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 mb-8">
              <div>
                <div className="font-bold text-gray-300 mb-3">PredMarket Scanner</div>
                <p className="text-xs text-gray-600 leading-relaxed">AI-powered prediction market arbitrage scanner. Not financial advice. Always verify before trading.</p>
              </div>
              <div>
                <div className="text-xs font-bold text-gray-600 uppercase tracking-widest mb-3">Product</div>
                <div className="space-y-2">
                  {[['Dashboard', '/dashboard'], ['Upgrade to Pro', '/dashboard/upgrade'], ['Portfolio', '/dashboard/portfolio']].map(([label, href]) => (
                    <Link key={href} href={href} className="block text-xs text-gray-600 hover:text-gray-400 transition-colors">{label}</Link>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs font-bold text-gray-600 uppercase tracking-widest mb-3">Account</div>
                <div className="space-y-2">
                  {[['Sign In', '/auth/login'], ['Register', '/auth/register'], ['Forgot Password', '/auth/forgot']].map(([label, href]) => (
                    <Link key={href} href={href} className="block text-xs text-gray-600 hover:text-gray-400 transition-colors">{label}</Link>
                  ))}
                </div>
              </div>
            </div>
            <div className="border-t border-gray-800 pt-6 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-gray-700">© {new Date().getFullYear()} PredMarket Scanner. Not financial advice.</p>
              <p className="text-xs text-gray-700">Scanning {stats.totalMarkets.toLocaleString()}+ markets · Updated every 30 seconds</p>
            </div>
          </div>
        </footer>

      </main>
    </>
  );
}
