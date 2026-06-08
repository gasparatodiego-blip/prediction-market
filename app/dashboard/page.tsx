'use client';
import Link from 'next/link';

export default function DashboardPage() {
    const categories = [
        { id: 'prediction', name: '🎯 Prediction Markets', color: 'blue', platforms: ['Polymarket', 'Kalshi', 'PredictIt', 'Manifold'], summary: 'Scommetti su eventi politici, sportivi, crypto e attualità', link: '/dashboard/prediction' },
        { id: 'crypto', name: '💰 Crypto & Funding Rates', color: 'purple', platforms: ['Binance', 'Bybit', 'OKX', 'Coinbase'], summary: 'Arbitraggio funding rates, spot vs futures, CEX arbitrage', link: '/dashboard/crypto' },
        { id: 'sports', name: '⚽ Sports Arbitrage', color: 'green', platforms: ['Bet365', 'DraftKings', 'FanDuel', 'William Hill'], summary: 'Confronta quote su 40+ bookmaker, trova surebet garantite', link: '/dashboard/sports' },
        { id: 'cex', name: '🔄 CEX Arbitrage', color: 'yellow', platforms: ['Binance', 'Coinbase', 'Kraken', 'Bybit', 'OKX'], summary: 'Differenze di prezzo tra exchange, profitto immediato', link: '/dashboard/cex' },
        { id: 'hft', name: '⚡ HFT 5-min', color: 'orange', platforms: ['Binance Futures', 'Bybit Perp', 'OKX Perp'], summary: 'Trading algoritmico ad alta frequenza su BTC, ETH, SOL', link: '/dashboard/hft' },
        { id: 'lp', name: '🏦 Liquidity Provider', color: 'teal', platforms: ['Polymarket LP', 'Uniswap V3', 'Jupiter'], summary: 'Fornisci liquidità e guadagna commissioni', link: '/dashboard/lp-sim' }
    ];

    const getColorClasses = (color: string) => {
        const colors: Record<string, string> = {
            blue: 'bg-blue-500/10 border-blue-500/30 text-blue-400',
            purple: 'bg-purple-500/10 border-purple-500/30 text-purple-400',
            green: 'bg-green-500/10 border-green-500/30 text-green-400',
            yellow: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400',
            orange: 'bg-orange-500/10 border-orange-500/30 text-orange-400',
            teal: 'bg-teal-500/10 border-teal-500/30 text-teal-400'
        };
        return colors[color] || colors.blue;
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950">
            {/* Header */}
            <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-md sticky top-0 z-10">
                <div className="max-w-7xl mx-auto px-4 py-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">ArbScanner</h1>
                            <p className="text-xs text-gray-500 mt-0.5">Piattaforma di Arbitraggio Multi-Strategia</p>
                        </div>
                        <Link href="/" className="px-4 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-sm hover:border-gray-500 transition">← Home</Link>
                    </div>
                </div>
            </header>

            {/* Hero */}
            <div className="max-w-7xl mx-auto px-4 py-8 text-center">
                <h2 className="text-2xl md:text-3xl font-bold text-white mb-2">Scegli la tua strategia di arbitraggio</h2>
                <p className="text-gray-400 text-sm max-w-2xl mx-auto">8 strategie automatizzate, 14 AI agents, 12+ piattaforme integrate</p>
            </div>

            {/* Categories Grid */}
            <div className="max-w-7xl mx-auto px-4 pb-12">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                    {categories.map((cat) => (
                        <Link key={cat.id} href={cat.link} className="group block p-5 rounded-xl border border-gray-800 bg-gray-900/40 hover:border-blue-500/30 hover:bg-gray-900/60 transition-all duration-200">
                            <div className="flex items-start gap-3">
                                <div className="text-3xl">{cat.name.split(' ')[0]}</div>
                                <div className="flex-1">
                                    <h3 className="font-bold text-white text-lg group-hover:text-blue-400 transition">{cat.name}</h3>
                                    <p className="text-xs text-gray-500 mt-1 leading-relaxed">{cat.summary}</p>
                                    <div className="flex flex-wrap gap-1.5 mt-3">
                                        {cat.platforms.slice(0, 3).map(p => (
                                            <span key={p} className={`text-xs px-2 py-0.5 rounded-full ${getColorClasses(cat.color)}`}>{p}</span>
                                        ))}
                                        {cat.platforms.length > 3 && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-500">+{cat.platforms.length - 3}</span>}
                                    </div>
                                </div>
                                <div className="text-gray-600 group-hover:text-blue-400 transition">→</div>
                            </div>
                        </Link>
                    ))}
                </div>
            </div>

            {/* Footer Stats */}
            <div className="border-t border-gray-800/50 bg-gray-900/30 py-6">
                <div className="max-w-7xl mx-auto px-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                        <div><div className="text-2xl font-bold text-blue-400">14+</div><div className="text-xs text-gray-500">AI Agents Attivi</div></div>
                        <div><div className="text-2xl font-bold text-purple-400">40+</div><div className="text-xs text-gray-500">Bookmaker Integrati</div></div>
                        <div><div className="text-2xl font-bold text-green-400">12+</div><div className="text-xs text-gray-500">Piattaforme Supportate</div></div>
                        <div><div className="text-2xl font-bold text-yellow-400">24/7</div><div className="text-xs text-gray-500">Scansione Continua</div></div>
                    </div>
                </div>
            </div>

            {/* Footer */}
            <footer className="border-t border-gray-800/50 py-6 text-center text-xs text-gray-600">
                <p>ArbScanner • Piattaforma di Arbitraggio Multi-Strategia • Beta</p>
            </footer>
        </div>
    );
}
