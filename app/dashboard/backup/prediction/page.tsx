'use client';

import { useState } from 'react';
import Link from 'next/link';

interface Market {
    id: number;
    title: string;
    yes: number;
    no: number;
    volume: string;
}

export default function PredictionPage() {
    const [amount, setAmount] = useState(100);
    const [markets] = useState<Market[]>([
        { id: 1, title: "Chi vincerà le elezioni USA 2024?", yes: 52, no: 48, volume: "1.2M" },
        { id: 2, title: "La Fed taglierà i tassi entro settembre?", yes: 45, no: 55, volume: "890K" },
        { id: 3, title: "Il Portogallo vincerà i Mondiali 2026?", yes: 38, no: 62, volume: "2.1M" },
    ]);

    const handleBet = (market: Market, side: string) => {
        alert(`🎯 Scommessa ${side} su "${market.title}" per $${amount}`);
    };

    return (
        <div className="min-h-screen bg-gray-950">
            <header className="border-b border-gray-800 bg-gray-900/50 px-4 py-3 sticky top-0">
                <div className="max-w-7xl mx-auto flex justify-between items-center">
                    <div><h1 className="text-xl font-bold text-white">🎯 Prediction Markets</h1><p className="text-xs text-gray-500">Polymarket • Kalshi • PredictIt • Manifold</p></div>
                    <Link href="/dashboard" className="px-3 py-1 rounded-lg border border-gray-700 text-gray-400 text-sm">← Dashboard</Link>
                </div>
            </header>
            <div className="max-w-7xl mx-auto p-4">
                <div className="grid grid-cols-1 gap-4">
                    {markets.map(m => (
                        <div key={m.id} className="bg-gray-900/40 rounded-xl border border-gray-800 p-4 hover:border-blue-500/30 transition">
                            <h3 className="font-semibold text-white mb-3">{m.title}</h3>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="bg-green-950/30 rounded-lg p-3 text-center border border-green-800/30">
                                    <div className="text-xs text-gray-400">YES</div>
                                    <div className="text-2xl font-bold text-green-400">{m.yes}¢</div>
                                    <button onClick={() => handleBet(m, 'YES')} className="mt-2 w-full py-1.5 rounded-lg bg-green-600/20 text-green-400 text-sm hover:bg-green-600/30 transition">BUY YES</button>
                                </div>
                                <div className="bg-red-950/30 rounded-lg p-3 text-center border border-red-800/30">
                                    <div className="text-xs text-gray-400">NO</div>
                                    <div className="text-2xl font-bold text-red-400">{m.no}¢</div>
                                    <button onClick={() => handleBet(m, 'NO')} className="mt-2 w-full py-1.5 rounded-lg bg-red-600/20 text-red-400 text-sm hover:bg-red-600/30 transition">BUY NO</button>
                                </div>
                            </div>
                            <div className="flex justify-between mt-3 text-xs text-gray-500">
                                <span>Volume: ${m.volume}</span>
                                <input type="number" value={amount} onChange={(e) => setAmount(parseFloat(e.target.value))} className="w-24 px-2 py-1 rounded bg-gray-800 border border-gray-700 text-white text-xs" placeholder="Amount" />
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
