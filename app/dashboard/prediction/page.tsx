'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function PredictionPage() {
    const [markets, setMarkets] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/markets').then(res => res.json()).then(data => {
            setMarkets(data.markets || []);
            setLoading(false);
        }).catch(() => setLoading(false));
    }, []);

    if (loading) return <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-500">Caricamento...</div>;

    return (
        <div className="min-h-screen bg-gray-950">
            <header className="border-b border-gray-800 bg-gray-900/50 px-4 py-4 sticky top-0">
                <div className="max-w-7xl mx-auto flex justify-between items-center">
                    <div><h1 className="text-xl font-bold text-white">🎯 Prediction Markets</h1><p className="text-xs text-gray-500">Polymarket • Kalshi • PredictIt • Manifold</p></div>
                    <Link href="/dashboard" className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-sm">← Dashboard</Link>
                </div>
            </header>
            <div className="max-w-7xl mx-auto px-4 py-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {markets.map((m: any) => (
                        <div key={m.id} className="rounded-xl border border-gray-800 bg-gray-900/30 p-4 hover:border-blue-500/30">
                            <div className="flex justify-between"><span className="px-2 py-0.5 rounded text-xs bg-blue-500/20 text-blue-400">{m.platform}</span><span className="text-xs text-gray-500">Vol: ${(m.volume/1000).toFixed(0)}k</span></div>
                            <h3 className="text-sm font-medium text-white mt-2">{m.title}</h3>
                            <div className="flex items-center gap-2 mt-3"><div className="flex-1 h-1.5 bg-gray-700 rounded-full"><div className="h-full bg-green-500 rounded-full" style={{ width: `${m.price}%` }} /></div><span className="text-sm font-bold text-green-400">{m.price.toFixed(1)}%</span></div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
