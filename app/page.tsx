'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';

export default function HomePage() {
    const [currentTip, setCurrentTip] = useState(0);
    const tips = ['🎯 Arbitraggio cross-platform: spread fino a 8%', '💰 Funding Rate BTC: +0.0087%/8h → +9.5% APY', '⚡ API in tempo reale per trading automatizzato', '🏦 LP: guadagna fino a 200% APY su Polymarket'];

    useEffect(() => {
        const interval = setInterval(() => setCurrentTip(prev => (prev + 1) % tips.length), 4000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950">
            <div className="fixed top-0 left-0 right-0 z-50 bg-gray-900/80 backdrop-blur-md border-b border-gray-800 px-4 py-3"><div className="max-w-7xl mx-auto flex justify-between items-center"><div className="flex items-center gap-2"><div className="w-8 h-8 rounded-lg bg-gradient-to-r from-blue-500 to-purple-500 flex items-center justify-center"><span className="text-white text-sm font-bold">A</span></div><span className="font-bold text-white text-lg">ArbScanner</span><span className="text-xs text-green-400 animate-pulse">● LIVE</span></div><Link href="/dashboard" className="px-4 py-1.5 rounded-lg bg-blue-600/20 text-blue-400 text-sm hover:bg-blue-600/30">Dashboard</Link></div></div>
            <div className="relative z-10 pt-20 pb-12"><div className="max-w-7xl mx-auto px-4 text-center"><div className="inline-flex items-center gap-2 bg-blue-500/10 rounded-full px-4 py-1.5 mb-4 border border-blue-500/20"><span className="text-purple-400 text-sm">⚡ AI-Powered • 24/7 Real-time</span></div><h1 className="text-5xl md:text-7xl font-bold mb-4"><span className="bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">Prediction Market</span><br /><span className="text-white">Arbitrage Scanner</span></h1><p className="text-gray-400 text-base max-w-2xl mx-auto mb-8">Scansiona prediction markets, bookmaker e exchange crypto in tempo reale. Scopri opportunità di arbitraggio e massimizza i profitti.</p><Link href="/dashboard" className="inline-flex items-center gap-2 px-8 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 text-white font-semibold hover:scale-105 transition">Accedi alla Dashboard →</Link><div className="max-w-md mx-auto mt-8"><div className="bg-gray-900/50 rounded-xl border border-gray-800 p-4"><div className="flex items-center gap-3"><span className="text-2xl">{tips[currentTip].split(' ')[0]}</span><p className="text-sm text-gray-300">{tips[currentTip]}</p></div></div></div><div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-10"><div><div className="text-2xl font-bold text-blue-400">14+</div><div className="text-xs text-gray-500">AI Agents</div></div><div><div className="text-2xl font-bold text-purple-400">40+</div><div className="text-xs text-gray-500">Bookmakers</div></div><div><div className="text-2xl font-bold text-green-400">12+</div><div className="text-xs text-gray-500">Platforms</div></div><div><div className="text-2xl font-bold text-yellow-400">24/7</div><div className="text-xs text-gray-500">Scanning</div></div></div></div></div>
        </div>
    );
}
