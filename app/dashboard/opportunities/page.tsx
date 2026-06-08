'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Opportunity {
    id: string;
    title: string;
    type: string;
    platform_a: string;
    platform_b: string;
    price_a: number;
    price_b: number;
    roi: number;
    net_roi: number;
    confidence: number;
    profit_on_1000: number;
    urgency: string;
    risk: string;
    url_a?: string;
    url_b?: string;
    description?: string;
}

interface Market {
    symbol: string;
    name: string;
    price: number;
    change: number;
    volume: number;
    fundingRate?: number;
}

interface Stats {
    totalOpportunities: number;
    avgRoi: number;
    bestRoi: number;
    totalProfitPotential: number;
    byType: Record<string, number>;
}

export default function OpportunitiesPage() {
    const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
    const [markets, setMarkets] = useState<Market[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all');
    const [sortBy, setSortBy] = useState('roi');

    const fetchData = async () => {
        try {
            // Fetch opportunità da agent-master
            const arbRes = await fetch('/api/arbitrage');
            const arbData = await arbRes.json();
            
            // Fetch prezzi crypto
            const marketsRes = await fetch('/api/hft');
            const marketsData = await marketsRes.json();
            
            if (arbData.opportunities) {
                setOpportunities(arbData.opportunities);
                
                // Calcola statistiche
                const byType: Record<string, number> = {};
                arbData.opportunities.forEach((opp: Opportunity) => {
                    byType[opp.type] = (byType[opp.type] || 0) + 1;
                });
                
                setStats({
                    totalOpportunities: arbData.opportunities.length,
                    avgRoi: arbData.opportunities.reduce((s: number, o: Opportunity) => s + o.roi, 0) / arbData.opportunities.length,
                    bestRoi: Math.max(...arbData.opportunities.map((o: Opportunity) => o.roi)),
                    totalProfitPotential: arbData.opportunities.reduce((s: number, o: Opportunity) => s + o.profit_on_1000, 0),
                    byType
                });
            }
            
            if (marketsData.markets) {
                setMarkets(marketsData.markets);
            }
        } catch (err) {
            console.error('Error fetching data:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 30000);
        return () => clearInterval(interval);
    }, []);

    const getTypeColor = (type: string) => {
        const colors: Record<string, string> = {
            prediction_market: 'bg-blue-500/20 text-blue-400 border-blue-500',
            funding_rate: 'bg-purple-500/20 text-purple-400 border-purple-500',
            cex_arb: 'bg-yellow-500/20 text-yellow-400 border-yellow-500',
            sports_arb: 'bg-green-500/20 text-green-400 border-green-500',
            cash_carry: 'bg-orange-500/20 text-orange-400 border-orange-500',
            info_lag: 'bg-pink-500/20 text-pink-400 border-pink-500'
        };
        return colors[type] || 'bg-gray-500/20 text-gray-400 border-gray-500';
    };

    const getUrgencyColor = (urgency: string) => {
        switch(urgency) {
            case 'high': return 'text-red-400 bg-red-950/30';
            case 'medium': return 'text-yellow-400 bg-yellow-950/30';
            default: return 'text-green-400 bg-green-950/30';
        }
    };

    const getRiskColor = (risk: string) => {
        switch(risk) {
            case 'high': return 'text-red-400';
            case 'medium': return 'text-yellow-400';
            default: return 'text-green-400';
        }
    };

    const formatCurrency = (value: number) => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(value);
    };

    const filteredOpps = opportunities
        .filter(opp => filter === 'all' || opp.type === filter)
        .sort((a, b) => {
            if (sortBy === 'roi') return b.roi - a.roi;
            if (sortBy === 'profit') return b.profit_on_1000 - a.profit_on_1000;
            if (sortBy === 'confidence') return b.confidence - a.confidence;
            return 0;
        });

    if (loading) {
        return (
            <div className="min-h-screen bg-gray-950 flex items-center justify-center">
                <div className="text-gray-400">Caricamento opportunità...</div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-950 text-white">
            {/* Header */}
            <header className="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/90 backdrop-blur-sm px-4 py-4">
                <div className="max-w-7xl mx-auto flex items-center justify-between">
                    <div>
                        <h1 className="text-xl font-bold">🎯 Opportunities Scanner</h1>
                        <p className="text-xs text-gray-500">Tutti i mercati e opportunità di arbitraggio</p>
                    </div>
                    <Link href="/dashboard" className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-sm hover:border-gray-500">
                        ← Dashboard
                    </Link>
                </div>
            </header>

            <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
                {/* STATS SPECCHIETTO */}
                {stats && (
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <div className="rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900/60 to-gray-900/40 p-4">
                            <div className="text-2xl font-bold text-blue-400">{stats.totalOpportunities}</div>
                            <div className="text-xs text-gray-500">Opportunità Totali</div>
                        </div>
                        <div className="rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900/60 to-gray-900/40 p-4">
                            <div className="text-2xl font-bold text-green-400">{stats.avgRoi.toFixed(1)}%</div>
                            <div className="text-xs text-gray-500">ROI Medio</div>
                        </div>
                        <div className="rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900/60 to-gray-900/40 p-4">
                            <div className="text-2xl font-bold text-yellow-400">{stats.bestRoi.toFixed(1)}%</div>
                            <div className="text-xs text-gray-500">Best ROI</div>
                        </div>
                        <div className="rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900/60 to-gray-900/40 p-4">
                            <div className="text-2xl font-bold text-purple-400">{formatCurrency(stats.totalProfitPotential)}</div>
                            <div className="text-xs text-gray-500">Profitto Potenziale</div>
                        </div>
                        <div className="rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900/60 to-gray-900/40 p-4">
                            <div className="text-xs text-gray-400 space-y-1">
                                {Object.entries(stats.byType).map(([type, count]) => (
                                    <div key={type} className="flex justify-between">
                                        <span className="capitalize">{type.replace('_', ' ')}</span>
                                        <span className="text-white font-bold">{count}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="text-xs text-gray-500 mt-1">Per Tipo</div>
                        </div>
                    </div>
                )}

                {/* FILTRI */}
                <div className="flex flex-wrap gap-2 items-center justify-between">
                    <div className="flex flex-wrap gap-2">
                        <button onClick={() => setFilter('all')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${filter === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>Tutti</button>
                        <button onClick={() => setFilter('prediction_market')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${filter === 'prediction_market' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>Prediction Market</button>
                        <button onClick={() => setFilter('funding_rate')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${filter === 'funding_rate' ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>Funding Rate</button>
                        <button onClick={() => setFilter('cex_arb')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${filter === 'cex_arb' ? 'bg-yellow-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>CEX Arb</button>
                        <button onClick={() => setFilter('cash_carry')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${filter === 'cash_carry' ? 'bg-orange-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>Cash & Carry</button>
                    </div>
                    <div className="flex gap-2">
                        <button onClick={() => setSortBy('roi')} className={`px-3 py-1.5 rounded-lg text-xs ${sortBy === 'roi' ? 'bg-gray-700 text-white' : 'bg-gray-800 text-gray-400'}`}>Per ROI</button>
                        <button onClick={() => setSortBy('profit')} className={`px-3 py-1.5 rounded-lg text-xs ${sortBy === 'profit' ? 'bg-gray-700 text-white' : 'bg-gray-800 text-gray-400'}`}>Per Profitto</button>
                        <button onClick={() => setSortBy('confidence')} className={`px-3 py-1.5 rounded-lg text-xs ${sortBy === 'confidence' ? 'bg-gray-700 text-white' : 'bg-gray-800 text-gray-400'}`}>Per Confidence</button>
                    </div>
                </div>

                {/* TABELLA OPPORTUNITÀ */}
                <div className="rounded-xl border border-gray-800 overflow-hidden">
                    <div className="bg-gray-900/60 px-4 py-3 border-b border-gray-800">
                        <h2 className="font-semibold text-sm">📈 Opportunità di Arbitraggio</h2>
                    </div>
                    {filteredOpps.length === 0 ? (
                        <div className="p-12 text-center text-gray-500">
                            <div className="text-4xl mb-2">🔍</div>
                            <p>Nessuna opportunità trovata</p>
                            <p className="text-xs mt-1">Attendi che l'AI Master analizzi i mercati</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="border-b border-gray-800 bg-gray-900/40 text-gray-500">
                                    <tr>
                                        <th className="px-4 py-3 text-left">Opportunità</th>
                                        <th className="px-4 py-3 text-center">Tipo</th>
                                        <th className="px-4 py-3 text-right">ROI Lordo</th>
                                        <th className="px-4 py-3 text-right">ROI Netto</th>
                                        <th className="px-4 py-3 text-right">Profitto $1000</th>
                                        <th className="px-4 py-3 text-center">Conf</th>
                                        <th className="px-4 py-3 text-center">Urgenza</th>
                                        <th className="px-4 py-3 text-center">Rischio</th>
                                        <th className="px-4 py-3 text-center">Azione</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-800/50">
                                    {filteredOpps.map((opp, idx) => (
                                        <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                                            <td className="px-4 py-3">
                                                <div className="max-w-md">
                                                    <p className="text-gray-200 text-sm font-medium">{opp.title}</p>
                                                    <p className="text-gray-600 text-xs mt-0.5">
                                                        {opp.platform_a} → {opp.platform_b}
                                                    </p>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <span className={`px-2 py-1 rounded-full text-xs font-semibold border ${getTypeColor(opp.type)}`}>
                                                    {opp.type.replace('_', ' ')}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <span className="font-bold text-green-400">+{opp.roi.toFixed(1)}%</span>
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <span className="font-bold text-blue-400">+{opp.net_roi?.toFixed(1) || opp.roi.toFixed(1)}%</span>
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <span className="font-bold text-yellow-400">+${opp.profit_on_1000.toFixed(0)}</span>
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <div className="flex items-center justify-center gap-1">
                                                    <div className="w-12 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                                        <div className="h-full bg-green-500 rounded-full" style={{ width: `${opp.confidence}%` }} />
                                                    </div>
                                                    <span className="text-xs text-gray-400">{opp.confidence}%</span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <span className={`px-2 py-0.5 rounded text-xs font-semibold ${getUrgencyColor(opp.urgency)}`}>
                                                    {opp.urgency?.toUpperCase() || 'MEDIUM'}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <span className={`text-xs font-semibold ${getRiskColor(opp.risk)}`}>
                                                    {opp.risk?.toUpperCase() || 'MEDIUM'}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-center">
                                                <button className="px-3 py-1 rounded-lg bg-blue-600/20 text-blue-400 text-xs hover:bg-blue-600/30 transition-colors">
                                                    Esegui
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* SPECCHIETTO RIASSUNTIVO FINALE */}
                <div className="rounded-xl border border-green-800/40 bg-green-950/20 p-5">
                    <div className="flex items-start gap-4">
                        <div className="text-3xl">📊</div>
                        <div className="flex-1">
                            <h3 className="font-bold text-green-400 mb-2">Specchietto Riassuntivo - Opportunità di Guadagno</h3>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                                <div>
                                    <p className="text-gray-400">🚀 Miglior ROI</p>
                                    <p className="text-2xl font-bold text-green-400">{stats?.bestRoi.toFixed(1)}%</p>
                                    <p className="text-xs text-gray-500">su {filteredOpps[0]?.title?.slice(0, 50) || 'N/A'}</p>
                                </div>
                                <div>
                                    <p className="text-gray-400">💰 Profitto Totale Potenziale</p>
                                    <p className="text-2xl font-bold text-yellow-400">{formatCurrency(stats?.totalProfitPotential || 0)}</p>
                                    <p className="text-xs text-gray-500">su investimento $1000 per opportunità</p>
                                </div>
                                <div>
                                    <p className="text-gray-400">⭐ Confidence Media</p>
                                    <p className="text-2xl font-bold text-purple-400">
                                        {opportunities.length > 0 
                                            ? (opportunities.reduce((s, o) => s + o.confidence, 0) / opportunities.length).toFixed(0)
                                            : 0}%
                                    </p>
                                    <p className="text-xs text-gray-500">affidabilità dei segnali</p>
                                </div>
                            </div>
                            <div className="mt-4 pt-3 border-t border-green-800/30 text-xs text-gray-500">
                                ⚡ Le opportunità vengono aggiornate ogni 30 secondi | Dati in tempo reale da AI Master Agent
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
