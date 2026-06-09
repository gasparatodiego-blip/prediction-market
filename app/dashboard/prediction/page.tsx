'use client';

import { useState, useEffect } from 'react';
import { PLATFORM_ICONS, getOpportunityBadge } from '@/lib/arbitrage';

interface Market {
    id: string;
    title: string;
    platform: string;
    category: string;
    yesPrice: number;
    noPrice: number;
    volume: number;
    endDate: string;
    fee: number;
    url: string;
}

interface Opportunity {
    id: string;
    event: string;
    buyYesOn: string;
    buyYesPrice: number;
    buyYesFee: number;
    buyNoOn: string;
    buyNoPrice: number;
    buyNoFee: number;
    spread: string;
    totalCost: number;
    profitPer100: any;
}

export default function PredictionPage() {
    const [markets, setMarkets] = useState<Market[]>([]);
    const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
    const [loading, setLoading] = useState(true);
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
    const [selectedOpportunity, setSelectedOpportunity] = useState<Opportunity | null>(null);
    const [investAmount, setInvestAmount] = useState(100);
    const [showProfitModal, setShowProfitModal] = useState(false);
    const [activeTab, setActiveTab] = useState<'arbitrage' | 'markets'>('arbitrage');

    useEffect(() => {
        fetchAll();
        const interval = setInterval(fetchAll, 30000);
        return () => clearInterval(interval);
    }, []);

    const fetchAll = async () => {
        try {
            const [poly, kalshi, pi, manifold, arb] = await Promise.all([
                fetch('/api/polymarket').then(r => r.json()),
                fetch('/api/kalshi').then(r => r.json()),
                fetch('/api/predictit').then(r => r.json()),
                fetch('/api/manifold').then(r => r.json()),
                fetch('/api/arbitrage').then(r => r.json())
            ]);
            
            const allMarkets: Market[] = [
                ...(poly.markets || []),
                ...(kalshi.markets || []),
                ...(pi.markets || []),
                ...(manifold.markets || [])
            ];
            
            setMarkets(allMarkets);
            setOpportunities(arb.opportunities || []);
            setLastUpdate(new Date());
        } catch (err) {
            console.error('Error:', err);
        } finally {
            setLoading(false);
        }
    };

    const openProfitModal = (opp: Opportunity) => {
        setSelectedOpportunity(opp);
        setShowProfitModal(true);
    };

    const getPlatformColor = (platform: string) => {
        const colors: Record<string, string> = {
            Polymarket: 'bg-purple-500/20 text-purple-400',
            Kalshi: 'bg-blue-500/20 text-blue-400',
            PredictIt: 'bg-orange-500/20 text-orange-400',
            Manifold: 'bg-green-500/20 text-green-400'
        };
        return colors[platform] || 'bg-gray-500/20 text-gray-400';
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-gray-950 flex items-center justify-center">
                <div className="text-gray-400">Caricamento mercati da 4 piattaforme...</div>
            </div>
        );
    }

    return (
        <div>
            <div className="max-w-7xl mx-auto px-4 py-6">
                {/* Statistiche */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                    <div className="bg-gradient-to-br from-blue-950/40 to-gray-900/40 rounded-xl p-4 border border-blue-800/30">
                        <div className="text-2xl font-bold text-blue-400">{opportunities.length}</div>
                        <div className="text-xs text-gray-500">Opportunità Arbitraggio</div>
                    </div>
                    <div className="bg-gradient-to-br from-green-950/40 to-gray-900/40 rounded-xl p-4 border border-green-800/30">
                        <div className="text-2xl font-bold text-green-400">{markets.length}</div>
                        <div className="text-xs text-gray-500">Mercati Totali</div>
                    </div>
                    <div className="bg-gradient-to-br from-purple-950/40 to-gray-900/40 rounded-xl p-4 border border-purple-800/30">
                        <div className="text-2xl font-bold text-purple-400">4</div>
                        <div className="text-xs text-gray-500">Piattaforme</div>
                    </div>
                    <div className="bg-gradient-to-br from-yellow-950/40 to-gray-900/40 rounded-xl p-4 border border-yellow-800/30">
                        <div className="text-2xl font-bold text-yellow-400">{opportunities.length > 0 ? opportunities[0]?.spread : 0}%</div>
                        <div className="text-xs text-gray-500">Miglior Spread</div>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-2 mb-6 border-b border-gray-800">
                    <button onClick={() => setActiveTab('arbitrage')} className={`px-6 py-2 text-sm font-semibold transition ${activeTab === 'arbitrage' ? 'text-green-400 border-b-2 border-green-400' : 'text-gray-400 hover:text-gray-300'}`}>
                        🔥 Opportunità Arbitraggio
                    </button>
                    <button onClick={() => setActiveTab('markets')} className={`px-6 py-2 text-sm font-semibold transition ${activeTab === 'markets' ? 'text-green-400 border-b-2 border-green-400' : 'text-gray-400 hover:text-gray-300'}`}>
                        📊 Tutti i Mercati
                    </button>
                </div>

                {/* Tab Arbitraggio */}
                {activeTab === 'arbitrage' && (
                    <>
                        {opportunities.length === 0 ? (
                            <div className="text-center py-12 text-gray-500 bg-gray-900/30 rounded-xl">
                                <p>🔍 Nessuna opportunità di arbitraggio al momento</p>
                                <p className="text-xs mt-1">Controlla tra 30 secondi per nuovi aggiornamenti</p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <h2 className="text-lg font-bold text-white">🔥 TOP OPPORTUNITÀ DI ARBITRAGGIO</h2>
                                {opportunities.slice(0, 5).map((opp, idx) => {
                                    const badge = getOpportunityBadge(parseFloat(opp.spread));
                                    return (
                                        <div key={opp.id} className="bg-gradient-to-r from-green-950/30 to-emerald-950/20 rounded-xl border border-green-800/30 p-4">
                                            <div className="flex justify-between items-start mb-2">
                                                <div className="flex items-center gap-2">
                                                    <span className={`px-2 py-1 rounded-full text-xs font-bold ${badge.bgColor} ${badge.textColor}`}>{badge.label}</span>
                                                    <span className="text-xs text-gray-500">Spread {opp.spread}%</span>
                                                </div>
                                                <button onClick={() => openProfitModal(opp)} className="text-xs text-blue-400 hover:text-blue-300">💲 Calcola profitto</button>
                                            </div>
                                            <h3 className="text-white font-semibold mb-3">{opp.event}</h3>
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                <div className="bg-gray-800/50 rounded-lg p-3">
                                                    <div className="text-xs text-gray-400 mb-1">COMPRA SÌ su {PLATFORM_ICONS[opp.buyYesOn]} {opp.buyYesOn}</div>
                                                    <div className="text-2xl font-bold text-green-400">{opp.buyYesPrice}¢</div>
                                                    <div className="text-xs text-gray-500">Fee: {opp.buyYesFee * 100}%</div>
                                                    <a href="#" target="_blank" className="inline-block mt-2 px-3 py-1 rounded bg-green-600/20 text-green-400 text-xs hover:bg-green-600/30">Esegui su {opp.buyYesOn} →</a>
                                                </div>
                                                <div className="bg-gray-800/50 rounded-lg p-3">
                                                    <div className="text-xs text-gray-400 mb-1">COMPRA NO su {PLATFORM_ICONS[opp.buyNoOn]} {opp.buyNoOn}</div>
                                                    <div className="text-2xl font-bold text-red-400">{opp.buyNoPrice}¢</div>
                                                    <div className="text-xs text-gray-500">Fee: {opp.buyNoFee * 100}%</div>
                                                    <a href="#" target="_blank" className="inline-block mt-2 px-3 py-1 rounded bg-red-600/20 text-red-400 text-xs hover:bg-red-600/30">Esegui su {opp.buyNoOn} →</a>
                                                </div>
                                            </div>
                                            <div className="mt-3 pt-2 border-t border-gray-700 text-center text-sm">
                                                <span className="text-yellow-400">💰 Investi $100 → Profitto netto ${opp.profitPer100.netProfit} ({opp.profitPer100.roi}% ROI)</span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}

                {/* Tab Mercati */}
                {activeTab === 'markets' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {markets.slice(0, 30).map((market, idx) => (
                            <div key={`${market.platform}-${market.id}-${idx}`} className="bg-gray-900/40 rounded-xl border border-gray-800 p-4 hover:border-blue-500/50 transition-all">
                                <div className="flex justify-between items-start mb-2">
                                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${getPlatformColor(market.platform)}`}>
                                        {market.platform} {market.fee > 0 ? `(fee ${market.fee}%)` : ''}
                                    </span>
                                    <span className="text-xs text-gray-500">Scade: {market.endDate}</span>
                                </div>
                                <h3 className="font-semibold text-white mb-3 text-sm line-clamp-2">{market.title}</h3>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="bg-green-950/30 rounded-lg p-3 text-center border border-green-800/30">
                                        <div className="text-xs text-green-400">SÌ</div>
                                        <div className="text-2xl font-bold text-green-400">{market.yesPrice}¢</div>
                                    </div>
                                    <div className="bg-red-950/30 rounded-lg p-3 text-center border border-red-800/30">
                                        <div className="text-xs text-red-400">NO</div>
                                        <div className="text-2xl font-bold text-red-400">{market.noPrice}¢</div>
                                    </div>
                                </div>
                                {market.volume > 0 && (
                                    <div className="mt-3 text-xs text-gray-500 text-center">
                                        Volume: ${market.volume.toLocaleString()}k
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Modal Calcolo Profitto */}
            {showProfitModal && selectedOpportunity && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-gray-900 rounded-2xl border border-gray-700 max-w-md w-full p-6">
                        <h3 className="text-white font-bold text-lg mb-4">💰 Calcolo Profitto Arbitraggio</h3>
                        <p className="text-gray-300 text-sm mb-3">{selectedOpportunity.event}</p>
                        <div className="bg-gray-800 rounded-lg p-3 space-y-2 text-sm">
                            <div className="flex justify-between"><span className="text-gray-400">Compra SÌ su:</span><span className="text-green-400">{selectedOpportunity.buyYesOn} a {selectedOpportunity.buyYesPrice}¢ (fee {selectedOpportunity.buyYesFee * 100}%)</span></div>
                            <div className="flex justify-between"><span className="text-gray-400">Compra NO su:</span><span className="text-red-400">{selectedOpportunity.buyNoOn} a {selectedOpportunity.buyNoPrice}¢ (fee {selectedOpportunity.buyNoFee * 100}%)</span></div>
                            <div className="flex justify-between"><span className="text-gray-400">Costo totale:</span><span className="text-white">{selectedOpportunity.buyYesPrice + selectedOpportunity.buyNoPrice}¢</span></div>
                            <div className="flex justify-between"><span className="text-gray-400">Spread:</span><span className="text-green-400">{selectedOpportunity.spread}%</span></div>
                            <div className="flex justify-between pt-2 border-t border-gray-700"><span className="text-gray-400">Importo:</span><input type="number" value={investAmount} onChange={(e) => setInvestAmount(parseFloat(e.target.value) || 0)} className="w-32 px-2 py-1 rounded bg-gray-700 text-white text-right" /></div>
                            <div className="flex justify-between"><span className="text-gray-400">Profitto netto:</span><span className="text-yellow-400 font-bold">${(parseFloat(selectedOpportunity.profitPer100.netProfit) * (investAmount / 100)).toFixed(2)}</span></div>
                            <div className="flex justify-between"><span className="text-gray-400">ROI:</span><span className="text-green-400">{selectedOpportunity.profitPer100.roi}%</span></div>
                        </div>
                        <div className="flex gap-3 mt-4">
                            <button onClick={() => setShowProfitModal(false)} className="flex-1 py-2 rounded-lg bg-gray-800 text-gray-400">Chiudi</button>
                            <button className="flex-1 py-2 rounded-lg bg-green-600 text-white">Esegui Trade</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
