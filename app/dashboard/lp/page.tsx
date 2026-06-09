'use client';

import { useEffect, useState } from 'react';

interface Position {
    marketId: string;
    question: string;
    source: string;
    entryPrice: number;
    amountUSD: number;
    estimatedAPY: number;
    volume24h: number;
    enteredAt: number;
    status: string;
    feesEarned: number;
    isSimulated?: boolean;
}

interface Summary {
    totalExposure: number;
    totalFees: number;
    avgAPY: number;
    activeCount: number;
    maxPositions: number;
    maxExposure: number;
    remainingCapital: number;
}

interface Candidate {
    id: string;
    question: string;
    price: number;
    volume24h: number;
    url: string;
}

export default function LPDashboard() {
    const [positions, setPositions] = useState<Position[]>([]);
    const [summary, setSummary] = useState<Summary | null>(null);
    const [candidates, setCandidates] = useState<Candidate[]>([]);
    const [loading, setLoading] = useState(true);
    const [autoRefresh, setAutoRefresh] = useState(true);

    const fetchData = async () => {
        try {
            const res = await fetch('/api/lp');
            const data = await res.json();
            if (data.success) {
                setPositions(data.positions);
                setSummary(data.summary);
                setCandidates(data.candidates);
            }
        } catch (err) {
            console.error('Error fetching LP data:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        if (autoRefresh) {
            const interval = setInterval(fetchData, 30000); // ogni 30 secondi
            return () => clearInterval(interval);
        }
    }, [autoRefresh]);

    const formatDate = (timestamp: number) => {
        return new Date(timestamp).toLocaleString();
    };

    const formatCurrency = (value: number) => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(value);
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-gray-950 flex items-center justify-center">
                <div className="text-gray-400">Caricamento dashboard LP...</div>
            </div>
        );
    }

    return (
        <div>
            <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 space-y-6">
                {/* Summary Cards */}
                {summary && (
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                            <div className="text-2xl font-bold text-blue-400">{summary.activeCount}/{summary.maxPositions}</div>
                            <div className="text-xs text-gray-500">Posizioni Attive</div>
                        </div>
                        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                            <div className="text-2xl font-bold text-green-400">{formatCurrency(summary.totalExposure)}</div>
                            <div className="text-xs text-gray-500">Esposizione Totale</div>
                        </div>
                        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                            <div className="text-2xl font-bold text-yellow-400">{summary.avgAPY}%</div>
                            <div className="text-xs text-gray-500">APY Media</div>
                        </div>
                        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                            <div className="text-2xl font-bold text-purple-400">{formatCurrency(summary.remainingCapital)}</div>
                            <div className="text-xs text-gray-500">Capitale Residuo</div>
                        </div>
                        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                            <div className="text-2xl font-bold text-orange-400">{formatCurrency(summary.totalFees)}</div>
                            <div className="text-xs text-gray-500">Fee Accumulate</div>
                        </div>
                    </div>
                )}

                {/* Positions Table */}
                <div className="rounded-xl border border-gray-800 overflow-hidden">
                    <div className="bg-gray-900/60 px-4 py-3 border-b border-gray-800">
                        <h2 className="font-semibold text-sm">📊 Posizioni LP Attive</h2>
                    </div>
                    {positions.length === 0 ? (
                        <div className="p-12 text-center text-gray-500">
                            <div className="text-4xl mb-2">📭</div>
                            <p>Nessuna posizione LP attiva</p>
                            <p className="text-xs mt-1">L'agente aprirà posizioni automaticamente quando trova opportunità</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="border-b border-gray-800 bg-gray-900/40 text-gray-500">
                                    <tr>
                                        <th className="px-4 py-3 text-left">Mercato</th>
                                        <th className="px-4 py-3 text-right">Importo</th>
                                        <th className="px-4 py-3 text-right">Entry Price</th>
                                        <th className="px-4 py-3 text-right">APY</th>
                                        <th className="px-4 py-3 text-right">Volume 24h</th>
                                        <th className="px-4 py-3 text-center">Stato</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-800/50">
                                    {positions.map((pos) => (
                                        <tr key={pos.marketId} className="hover:bg-white/[0.02]">
                                            <td className="px-4 py-3">
                                                <div className="max-w-md">
                                                    <p className="text-gray-200 text-sm">{pos.question}</p>
                                                    <p className="text-gray-600 text-xs mt-0.5">
                                                        {pos.source} • {formatDate(pos.enteredAt)}
                                                        {pos.isSimulated && <span className="ml-2 text-yellow-500">(simulazione)</span>}
                                                    </p>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-right font-semibold text-green-400">
                                                {formatCurrency(pos.amountUSD)}
                                            </td>
                                            <td className="px-4 py-3 text-right text-gray-300">
                                                {pos.entryPrice}¢
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <span className="text-green-400 font-semibold">{pos.estimatedAPY.toFixed(0)}%</span>
                                            </td>
                                            <td className="px-4 py-3 text-right text-gray-400">
                                                {formatCurrency(pos.volume24h)}
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-green-950/40 text-green-400 border border-green-800">
                                                    ● attivo
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Candidates */}
                {candidates.length > 0 && (
                    <div className="rounded-xl border border-gray-800 overflow-hidden">
                        <div className="bg-gray-900/60 px-4 py-3 border-b border-gray-800">
                            <h2 className="font-semibold text-sm">🎯 Mercati Candidati per LP</h2>
                        </div>
                        <div className="divide-y divide-gray-800/50">
                            {candidates.map((c) => (
                                <div key={c.id} className="px-4 py-3 flex items-center justify-between hover:bg-white/[0.02]">
                                    <div className="flex-1">
                                        <p className="text-gray-200 text-sm">{c.question}</p>
                                        <div className="flex gap-4 mt-1 text-xs text-gray-500">
                                            <span>💰 Prezzo: {c.price}¢</span>
                                            <span>📊 Volume 24h: {formatCurrency(c.volume24h)}</span>
                                        </div>
                                    </div>
                                    {c.url && (
                                        <a href={c.url} target="_blank" rel="noopener noreferrer" 
                                           className="ml-4 px-3 py-1.5 rounded-lg bg-gray-800 text-gray-400 text-xs hover:bg-gray-700 hover:text-white transition-colors">
                                            📈 Vedi →
                                        </a>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Info Footer */}
                <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
                    <div className="flex items-start gap-3">
                        <div className="text-2xl">ℹ️</div>
                        <div>
                            <p className="text-sm text-gray-300 font-semibold">Come funziona?</p>
                            <p className="text-xs text-gray-500 mt-1">
                                L'agente LP Provider scansiona automaticamente i mercati Polymarket ogni 5 minuti. 
                                Quando trova un mercato con volume elevato e prezzo bilanciato (35-65¢), apre una posizione 
                                di liquidità usando il Kelly Criterion per dimensionare l'investimento. Le fee generate 
                                vengono automaticamente reinvestite.
                            </p>
                            <p className="text-xs text-gray-600 mt-2">
                                📍 Modalità attuale: <span className="text-yellow-500">SIMULAZIONE</span> (nessun vero trade)
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
