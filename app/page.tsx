'use client';

import Link from 'next/link';

export default function HomePage() {
    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950">
            {/* Hero Section */}
            <div className="relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-r from-blue-600/10 to-purple-600/10 blur-3xl" />
                <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 pb-32">
                    <div className="text-center">
                        <div className="inline-flex items-center gap-2 bg-blue-500/10 backdrop-blur-sm rounded-full px-4 py-1.5 mb-6 border border-blue-500/20">
                            <span className="text-purple-400 text-sm">⚡ Real-time Arbitrage</span>
                        </div>
                        <h1 className="text-5xl md:text-7xl font-bold mb-6">
                            <span className="bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
                                Prediction Market
                            </span>
                            <br />
                            <span className="text-white">Arbitrage Scanner</span>
                        </h1>
                        <p className="text-gray-400 text-lg md:text-xl max-w-2xl mx-auto mb-10">
                            Scansiona prediction markets, bookmakers e exchange crypto in tempo reale. 
                            Scopri opportunità di arbitraggio, ricevi alert istantanei e massimizza i tuoi profitti con strategie automatizzate.
                        </p>
                        <div className="flex flex-wrap gap-4 justify-center">
                            <Link href="/dashboard" className="px-8 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 text-white font-semibold hover:from-blue-500 hover:to-blue-400 transition-all shadow-lg shadow-blue-500/25">
                                Launch Dashboard →
                            </Link>
                            <button className="px-8 py-3 rounded-xl border border-gray-700 text-gray-300 font-semibold hover:bg-gray-800/50 transition-all">
                                Watch Demo
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Stats Banner */}
            <div className="border-t border-gray-800/50 bg-gray-900/30 backdrop-blur-sm">
                <div className="max-w-7xl mx-auto px-4 py-8">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
                        <div>
                            <div className="text-3xl font-bold text-blue-400">14+</div>
                            <div className="text-xs text-gray-500 mt-1">AI Agents</div>
                        </div>
                        <div>
                            <div className="text-3xl font-bold text-purple-400">12+</div>
                            <div className="text-xs text-gray-500 mt-1">Platforms</div>
                        </div>
                        <div>
                            <div className="text-3xl font-bold text-green-400">24/7</div>
                            <div className="text-xs text-gray-500 mt-1">Real-time Scanning</div>
                        </div>
                        <div>
                            <div className="text-3xl font-bold text-yellow-400">200%+</div>
                            <div className="text-xs text-gray-500 mt-1">Potential APY</div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Features Grid */}
            <div className="max-w-7xl mx-auto px-4 py-20">
                <div className="text-center mb-12">
                    <h2 className="text-3xl font-bold text-white mb-4">Multi-Strategy Arbitrage</h2>
                    <p className="text-gray-400 max-w-2xl mx-auto">
                        8 diverse strategie di arbitraggio automatizzate da AI agents
                    </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
                    <div className="bg-gray-900/40 rounded-xl p-5 border border-gray-800 hover:border-blue-500/30 transition-all">
                        <div className="text-3xl mb-3">🎯</div>
                        <h3 className="font-semibold text-white mb-1">Prediction Markets</h3>
                        <p className="text-xs text-gray-500">Polymarket • Kalshi • PredictIt • Manifold</p>
                    </div>
                    <div className="bg-gray-900/40 rounded-xl p-5 border border-gray-800 hover:border-purple-500/30 transition-all">
                        <div className="text-3xl mb-3">💰</div>
                        <h3 className="font-semibold text-white mb-1">Funding Rate Arb</h3>
                        <p className="text-xs text-gray-500">Binance • Bybit • OKX perpetuals</p>
                    </div>
                    <div className="bg-gray-900/40 rounded-xl p-5 border border-gray-800 hover:border-green-500/30 transition-all">
                        <div className="text-3xl mb-3">🔄</div>
                        <h3 className="font-semibold text-white mb-1">CEX Arbitrage</h3>
                        <p className="text-xs text-gray-500">6 exchanges • Real-time prices</p>
                    </div>
                    <div className="bg-gray-900/40 rounded-xl p-5 border border-gray-800 hover:border-yellow-500/30 transition-all">
                        <div className="text-3xl mb-3">⚽</div>
                        <h3 className="font-semibold text-white mb-1">Sports Arbitrage</h3>
                        <p className="text-xs text-gray-500">40+ bookmakers via OddsAPI</p>
                    </div>
                </div>
            </div>

            {/* Footer */}
            <footer className="border-t border-gray-800/50 py-8 text-center text-xs text-gray-600">
                <p>© 2026 ArbScanner • AI-Powered Arbitrage Scanner • Beta Version</p>
            </footer>
        </div>
    );
}
