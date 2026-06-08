'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function CryptoPage() {
    const [prices, setPrices] = useState({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/crypto').then(res => res.json()).then(data => {
            setPrices(data.prices || {});
            setLoading(false);
        }).catch(() => setLoading(false));
    }, []);

    if (loading) return <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-500">Caricamento...</div>;

    return (
        <div className="min-h-screen bg-gray-950">
            <header className="border-b border-gray-800 bg-gray-900/50 px-4 py-4 sticky top-0">
                <div className="max-w-7xl mx-auto flex justify-between items-center">
                    <div><h1 className="text-xl font-bold text-white">💰 Crypto & Funding Rates</h1><p className="text-xs text-gray-500">Binance • Bybit • OKX • Coinbase • Kraken</p></div>
                    <Link href="/dashboard" className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-sm">← Dashboard</Link>
                </div>
            </header>
            <div className="max-w-7xl mx-auto px-4 py-6">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {Object.entries(prices).map(([coin, data]: any) => (
                        <div key={coin} className="rounded-xl border border-gray-800 bg-gray-900/30 p-4">
                            <div className="flex justify-between items-center"><h3 className="text-lg font-bold text-white">{coin}</h3><span className={`text-sm ${data.change24h >= 0 ? 'text-green-400' : 'text-red-400'}`}>{data.change24h >= 0 ? '+' : ''}{data.change24h}%</span></div>
                            <div className="text-2xl font-bold text-white font-mono mt-2">${data.price?.toLocaleString()}</div>
                            <div className="flex justify-between mt-3 text-sm"><span className="text-gray-500">Volume 24h</span><span className="text-gray-300">${(data.volume / 1e9).toFixed(1)}B</span></div>
                            <div className="flex justify-between text-sm"><span className="text-gray-500">Funding Rate</span><span className="text-purple-400">{data.fundingRate}% / 8h</span></div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
