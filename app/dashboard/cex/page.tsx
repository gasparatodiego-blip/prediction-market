'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

export default function CEXPage() {
    const [prices, setPrices] = useState<Record<string, number>>({});
    const exchanges = ['Binance', 'Coinbase', 'Kraken', 'Bybit', 'OKX'];

    useEffect(() => {
        const generatePrices = () => {
            const newPrices: Record<string, number> = {};
            exchanges.forEach(ex => {
                newPrices[ex] = 94300 * (1 + (Math.random() - 0.5) * 0.008);
            });
            setPrices(newPrices);
        };
        generatePrices();
        const interval = setInterval(generatePrices, 5000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="min-h-screen bg-gray-950">
            <header className="border-b border-gray-800 bg-gray-900/50 px-4 py-3 sticky top-0">
                <div className="max-w-7xl mx-auto flex justify-between items-center">
                    <div><h1 className="text-xl font-bold text-white">🔄 CEX Arbitrage</h1><p className="text-xs text-gray-500">6 Exchange • Spread &gt;0.3%</p></div>
                    <Link href="/dashboard" className="px-3 py-1 rounded-lg border border-gray-700 text-gray-400 text-sm">← Dashboard</Link>
                </div>
            </header>
            <div className="max-w-7xl mx-auto p-4">
                <table className="w-full text-sm">
                    <thead className="bg-gray-800/50"><tr><th className="p-3 text-left text-gray-400">Exchange</th><th className="p-3 text-right text-gray-400">BTC/USDT</th></tr></thead>
                    <tbody className="divide-y divide-gray-800">
                        {exchanges.map(ex => (<tr key={ex} className="hover:bg-gray-800/30"><td className="p-3 font-medium text-white">{ex}</td><td className="p-3 text-right font-mono">{prices[ex] ? `$${prices[ex].toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '...'}</td></tr>))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
