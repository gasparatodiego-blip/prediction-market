'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Position {
    id: number;
    symbol: string;
    name: string;
    type: string;
    entryPrice: number;
    currentPrice?: number;
    size: number;
    confidence: number;
    pnlPercent: number;
    pnl: number;
    entryTime: number;
    status: string;
}

interface Stats {
    totalValue: number;
    pnl: number;
    roi: string;
    winRate: string;
    totalTrades: number;
    winningTrades: number;
    openPositions: number;
    totalExposure: number;
    usdtBalance: number;
}

interface Market {
    symbol: string;
    name: string;
    price: number;
    change24h?: number;
    change5min?: number;
}

export default function HFTDashboard() {
    const [stats, setStats] = useState<Stats | null>(null);
    const [positions, setPositions] = useState<Position[]>([]);
    const [markets, setMarkets] = useState<Market[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchData = async () => {
        try {
            const res = await fetch('/api/hft');
            const data = await res.json();
            if (data.success) {
                setStats(data.stats);
                setPositions(data.positions || []);
                setMarkets(data.markets || []);
            }
        } catch (err) {
            console.error('Fetch error:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 10000);
        return () => clearInterval(interval);
    }, []);

    const formatCurrency = (value: number) => {
        if (!value) return '$0';
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: value < 1 ? 4 : 0,
            maximumFractionDigits: value < 1 ? 4 : 0
        }).format(value);
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-gray-950 flex items-center justify-center">
                <div className="text-gray-400">Caricamento...</div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-950 text-white">
            <header className="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/90 px-4 py-4">
                <div className="flex items-center justify-between max-w-7xl mx-auto">
                    <div>
                        <h1 className="text-xl font-bold">📈 HFT 5-min Simulator</h1>
                        <p className="text-xs text-gray-500">Prezzi reali Binance | Simulazione</p>
                    </div>
                    <Link href="/dashboard" className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-sm hover:border-gray-500">
                        ← Dashboard
                    </Link>
                </div>
            </header>

            <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
                {stats && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                            <div className={`text-2xl font-bold ${stats.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {formatCurrency(stats.totalValue)}
                            </div>
                            <div className="text-xs text-gray-500">Portafoglio</div>
                            <div className={`text-xs ${stats.pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                PnL: {stats.pnl >= 0 ? '+' : ''}{formatCurrency(stats.pnl)} ({stats.roi}%)
                            </div>
                        </div>
                        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                            <div className="text-2xl font-bold text-blue-400">{stats.openPositions}</div>
                            <div className="text-xs text-gray-500">Posizioni Aperte</div>
                        </div>
                        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                            <div className="text-2xl font-bold text-green-400">{stats.winRate}%</div>
                            <div className="text-xs text-gray-500">Win Rate</div>
                            <div className="text-xs text-gray-600">{stats.winningTrades}/{stats.totalTrades} trades</div>
                        </div>
                        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                            <div className="text-2xl font-bold text-yellow-400">{formatCurrency(stats.usdtBalance)}</div>
                            <div className="text-xs text-gray-500">Capitale Libero</div>
                        </div>
                    </div>
                )}

                <div className="rounded-xl border border-gray-800 overflow-hidden">
                    <div className="bg-gray-900/60 px-4 py-3 border-b border-gray-800">
                        <h2 className="font-semibold text-sm">🔄 Mercati Monitorati (Binance Real-Time)</h2>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 p-4">
                        {markets.map((m) => (
                            <div key={m.symbol} className="px-3 py-2 rounded-lg bg-gray-900/30 border border-gray-800 text-center">
                                <div className="font-semibold text-sm">{m.name}</div>
                                <div className="text-base font-bold">{formatCurrency(m.price)}</div>
                                <div className={`text-xs ${(m.change5min || m.change24h || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    {(m.change5min || m.change24h || 0) >= 0 ? '+' : ''}{(m.change5min || m.change24h || 0).toFixed(2)}%
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="rounded-xl border border-gray-800 overflow-hidden">
                    <div className="bg-gray-900/60 px-4 py-3 border-b border-gray-800">
                        <h2 className="font-semibold text-sm">🎯 Posizioni Aperte</h2>
                    </div>
                    {positions.length === 0 ? (
                        <div className="p-8 text-center text-gray-500">
                            <div className="text-2xl mb-1">⏳</div>
                            <p>Nessuna posizione aperta</p>
                            <p className="text-xs">In attesa di segnali HFT...</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="border-b border-gray-800 bg-gray-900/40 text-gray-500">
                                    <tr>
                                        <th className="px-4 py-2 text-left">Mercato</th>
                                        <th className="px-4 py-2 text-center">Direzione</th>
                                        <th className="px-4 py-2 text-right">Entry</th>
                                        <th className="px-4 py-2 text-right">Size</th>
                                        <th className="px-4 py-2 text-right">PnL</th>
                                        <th className="px-4 py-2 text-center">Conf</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-800/50">
                                    {positions.map((pos) => (
                                        <tr key={pos.id} className="hover:bg-white/[0.02]">
                                            <td className="px-4 py-2 font-medium">{pos.name}</td>
                                            <td className="px-4 py-2 text-center">
                                                <span className={`px-2 py-1 rounded text-xs font-bold ${
                                                    pos.type === 'long' ? 'bg-green-950/40 text-green-400' : 'bg-red-950/40 text-red-400'
                                                }`}>
                                                    {pos.type.toUpperCase()}
                                                </span>
                                            </td>
                                            <td className="px-4 py-2 text-right font-mono">{formatCurrency(pos.entryPrice)}</td>
                                            <td className="px-4 py-2 text-right">{formatCurrency(pos.size)}</td>
                                            <td className="px-4 py-2 text-right">
                                                <span className={`font-bold ${pos.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                    {pos.pnl >= 0 ? '+' : ''}{pos.pnlPercent?.toFixed(2)}%
                                                </span>
                                            </td>
                                            <td className="px-4 py-2 text-center">
                                                <span className="text-yellow-400 font-bold">{pos.confidence}%</span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
