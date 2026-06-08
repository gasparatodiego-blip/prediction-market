'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function CEXPage() {
    const [prices, setPrices] = useState({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/cex').then(res => res.json()).then(data => {
            setPrices(data.prices || {});
            setLoading(false);
        }).catch(() => setLoading(false));
    }, []);

    if (loading) return <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-500">Caricamento...</div>;

    return (
        <div className="min-h-screen bg-gray-950">
            <header className="border-b border-gray-800 bg-gray-900/50 px-4 py-4 sticky top-0">
                <div className="max-w-7xl mx-auto flex justify-between items-center">
                    <div><h1 className="text-xl font-bold text-white">🔄 CEX Arbitrage</h1><p className="text-xs text-gray-500">Binance • Coinbase • Kraken • Bybit • OKX • Gate.io</p></div>
                    <Link href="/dashboard" className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-sm">← Dashboard</Link>
                </div>
            </header>
            <div className="max-w-7xl mx-auto px-4 py-6">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="border-b border-gray-800 bg-gray-900/50"><tr className="text-left text-gray-400"><th className="px-4 py-3">Exchange</th><th className="px-4 py-3">BTC</th><th className="px-4 py-3">ETH</th><th className="px-4 py-3">SOL</th></tr></thead>
                        <tbody className="divide-y divide-gray-800">
                            {Object.entries(prices).map(([exchange, coins]: any) => (
                                <tr key={exchange} className="hover:bg-gray-900/30"><td className="px-4 py-3 font-medium text-white">{exchange}</td><td className="px-4 py-3 font-mono">${coins.BTC?.toLocaleString()}</td><td className="px-4 py-3 font-mono">${coins.ETH?.toLocaleString()}</td><td className="px-4 py-3 font-mono">${coins.SOL?.toLocaleString()}</td></tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
