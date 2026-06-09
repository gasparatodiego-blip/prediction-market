'use client';

import Link from 'next/link';

export default function DashboardPage() {
    const categories = [
        { id: 'prediction', name: '🎯 Prediction Markets', platforms: ['Polymarket', 'Kalshi', 'PredictIt'], summary: 'Scommetti su eventi politici, sportivi e attualità', link: '/dashboard/prediction' },
        { id: 'crypto', name: '💰 Crypto & Funding', platforms: ['Binance', 'Bybit', 'OKX'], summary: 'Funding rates e arbitraggio spot-futures', link: '/dashboard/crypto' },
        { id: 'sports', name: '⚽ Sports Arbitrage', platforms: ['Bet365', 'DraftKings'], summary: 'Surebet su 40+ bookmaker', link: '/dashboard/sports' },
        { id: 'cex', name: '🔄 CEX Arbitrage', platforms: ['Binance', 'Coinbase', 'Kraken'], summary: 'Differenze di prezzo tra exchange', link: '/dashboard/cex' },
        { id: 'hft', name: '⚡ HFT 5-min', platforms: ['Binance Futures'], summary: 'Trading algoritmico ad alta frequenza', link: '/dashboard/hft' },
        { id: 'lp', name: '🏦 Liquidity Provider', platforms: ['Polymarket LP'], summary: 'Guadagna commissioni fornendo liquidità', link: '/dashboard/lp-sim' }
    ];

    return (
        <div className="min-h-screen bg-[#0A0C10]">
            <header className="border-b border-[#232834] bg-[#12151C] px-4 py-4 sticky top-0">
                <div className="max-w-7xl mx-auto flex justify-between items-center">
                    <div><h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">ArbScanner</h1><p className="text-xs text-gray-500">Piattaforma di Arbitraggio Multi-Strategia</p></div>
                    <Link href="/" className="px-4 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-sm">← Home</Link>
                </div>
            </header>
            <div className="max-w-7xl mx-auto px-4 py-8">
                <div className="text-center mb-8"><h2 className="text-2xl font-bold text-white">Scegli la tua strategia</h2><p className="text-gray-400 text-sm">8 strategie automatizzate, 14 AI agents</p></div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                    {categories.map((cat) => (
                        <Link key={cat.id} href={cat.link}>
                            <div className="p-5 rounded-xl border border-gray-800 bg-gray-900/40 hover:border-blue-500/30 hover:bg-gray-900/60 transition cursor-pointer">
                                <div className="flex items-start gap-3"><div className="text-3xl">{cat.name.split(' ')[0]}</div><div><h3 className="font-bold text-white">{cat.name}</h3><p className="text-xs text-gray-500 mt-1">{cat.summary}</p><div className="flex flex-wrap gap-1 mt-2">{cat.platforms.map(p=><span key={p} className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">{p}</span>)}</div></div></div>
                            </div>
                        </Link>
                    ))}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-10 pt-6 border-t border-gray-800 text-center">
                    <div><div className="text-2xl font-bold text-blue-400">14+</div><div className="text-xs text-gray-500">AI Agents</div></div>
                    <div><div className="text-2xl font-bold text-purple-400">40+</div><div className="text-xs text-gray-500">Bookmaker</div></div>
                    <div><div className="text-2xl font-bold text-green-400">12+</div><div className="text-xs text-gray-500">Platforms</div></div>
                    <div><div className="text-2xl font-bold text-yellow-400">24/7</div><div className="text-xs text-gray-500">Scanning</div></div>
                </div>
            </div>
        </div>
    );
}
