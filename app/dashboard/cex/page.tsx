'use client';

import { useState, useEffect } from 'react';

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
        <div>
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
