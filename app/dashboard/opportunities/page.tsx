'use client';

import { useEffect, useState } from 'react';

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

const TYPE_LABELS: Record<string, string> = {
    prediction_market: 'PRED-MKT',
    funding_rate:      'FUND-RATE',
    cex_arb:           'CEX-ARB',
    sports_arb:        'SPORTS',
    cash_carry:        'CASH+CRY',
    info_lag:          'INFO-LAG',
};

export default function OpportunitiesPage() {
    const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
    const [markets, setMarkets] = useState<Market[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all');
    const [sortBy, setSortBy] = useState('roi');
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

    const fetchData = async () => {
        try {
            const arbRes = await fetch('/api/arbitrage');
            const arbData = await arbRes.json();

            const marketsRes = await fetch('/api/hft');
            const marketsData = await marketsRes.json();

            if (arbData.opportunities) {
                setOpportunities(arbData.opportunities);

                const byType: Record<string, number> = {};
                arbData.opportunities.forEach((opp: Opportunity) => {
                    byType[opp.type] = (byType[opp.type] || 0) + 1;
                });

                setStats({
                    totalOpportunities: arbData.opportunities.length,
                    avgRoi: arbData.opportunities.reduce((s: number, o: Opportunity) => s + o.roi, 0) / arbData.opportunities.length,
                    bestRoi: Math.max(...arbData.opportunities.map((o: Opportunity) => o.roi)),
                    totalProfitPotential: arbData.opportunities.reduce((s: number, o: Opportunity) => s + o.profit_on_1000, 0),
                    byType,
                });
            }

            if (marketsData.markets) {
                setMarkets(marketsData.markets);
            }
            setLastUpdate(new Date());
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

    const filteredOpps = opportunities
        .filter(opp => filter === 'all' || opp.type === filter)
        .sort((a, b) => {
            if (sortBy === 'roi') return b.roi - a.roi;
            if (sortBy === 'profit') return b.profit_on_1000 - a.profit_on_1000;
            if (sortBy === 'confidence') return b.confidence - a.confidence;
            return 0;
        });

    const formatCurrency = (value: number) =>
        new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);

    if (loading) {
        return (
            <div className="min-h-screen bg-bg-base flex items-center justify-center">
                <span className="font-mono text-xs text-text-muted tracking-widest animate-pulse">LOADING OPPORTUNITIES...</span>
            </div>
        );
    }

    return (
        <div>
            <div className="max-w-7xl mx-auto px-4 py-4 space-y-3">

                {/* ── Stats strip ──────────────────────────────────── */}
                {stats && (
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                        {[
                            { label: 'OPPORTUNITIES',    value: stats.totalOpportunities,           color: 'text-accent'    },
                            { label: 'AVG ROI',          value: `${stats.avgRoi.toFixed(2)}%`,      color: 'text-positive'  },
                            { label: 'BEST ROI',         value: `${stats.bestRoi.toFixed(2)}%`,     color: 'text-warning'   },
                            { label: 'PROFIT POTENTIAL', value: formatCurrency(stats.totalProfitPotential), color: 'text-positive' },
                        ].map(({ label, value, color }) => (
                            <div key={label} className="border border-border bg-bg-panel p-3 rounded-sm">
                                <div className={`font-mono text-lg font-bold ${color}`}>{value}</div>
                                <div className="font-mono text-xs text-text-muted uppercase tracking-wider mt-0.5">{label}</div>
                            </div>
                        ))}
                        <div className="border border-border bg-bg-panel p-3 rounded-sm">
                            <div className="space-y-1">
                                {Object.entries(stats.byType).map(([type, count]) => (
                                    <div key={type} className="flex justify-between items-center">
                                        <span className="font-mono text-xs text-text-secondary">{TYPE_LABELS[type] || type.toUpperCase()}</span>
                                        <span className="font-mono text-xs text-text-primary font-bold">{count}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="font-mono text-xs text-text-muted uppercase tracking-wider mt-1">BY TYPE</div>
                        </div>
                    </div>
                )}

                {/* ── Filter / sort bar ────────────────────────────── */}
                <div className="flex flex-wrap gap-1.5 items-center justify-between border border-border bg-bg-panel px-3 py-2 rounded-sm">
                    <div className="flex flex-wrap gap-1.5">
                        {[
                            { key: 'all',               label: 'ALL'      },
                            { key: 'prediction_market', label: 'PRED-MKT' },
                            { key: 'funding_rate',      label: 'FUND-RATE'},
                            { key: 'cex_arb',           label: 'CEX-ARB'  },
                            { key: 'cash_carry',        label: 'CASH+CRY' },
                        ].map(({ key, label }) => (
                            <button
                                key={key}
                                onClick={() => setFilter(key)}
                                className={`px-2 py-0.5 font-mono text-xs border rounded-sm transition-colors duration-100 ${
                                    filter === key
                                        ? 'bg-accent text-white border-accent'
                                        : 'border-border text-text-secondary hover:border-text-muted hover:text-text-primary'
                                }`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <div className="flex gap-1.5">
                        {[
                            { key: 'roi',        label: 'ROI'    },
                            { key: 'profit',     label: 'PROFIT' },
                            { key: 'confidence', label: 'CONF'   },
                        ].map(({ key, label }) => (
                            <button
                                key={key}
                                onClick={() => setSortBy(key)}
                                className={`px-2 py-0.5 font-mono text-xs border rounded-sm transition-colors duration-100 ${
                                    sortBy === key
                                        ? 'bg-bg-elevated border-text-muted text-text-primary'
                                        : 'border-border text-text-muted hover:border-text-secondary'
                                }`}
                            >
                                SORT:{label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* ── Main opportunities table ─────────────────────── */}
                <div className="border border-border rounded-sm overflow-hidden">

                    {/* Table title + LIVE indicator */}
                    <div className="bg-bg-panel px-4 py-2 border-b border-border flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-semibold text-text-primary uppercase tracking-wider">
                                ARBITRAGE OPPORTUNITIES
                            </span>
                            <div className="flex items-center gap-1.5 ml-2">
                                <span className="relative flex h-1.5 w-1.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
                                </span>
                                <span className="font-mono text-xs text-accent">LIVE</span>
                                {lastUpdate && (
                                    <span className="font-mono text-xs text-text-muted ml-1">
                                        {lastUpdate.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                    </span>
                                )}
                            </div>
                        </div>
                        <span className="font-mono text-xs text-text-muted">{filteredOpps.length} RESULTS</span>
                    </div>

                    {filteredOpps.length === 0 ? (
                        <div className="p-12 text-center bg-bg-panel">
                            <div className="font-mono text-xs text-text-muted">NO OPPORTUNITIES FOUND</div>
                            <div className="font-mono text-xs text-text-muted mt-1">WAITING FOR AI AGENT ANALYSIS...</div>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead className="sticky top-0 z-10 bg-bg-panel border-b-2 border-border">
                                    <tr>
                                        <th className="px-3 py-2 text-left  font-mono text-xs text-text-muted uppercase tracking-wider whitespace-nowrap">OPPORTUNITY</th>
                                        <th className="px-3 py-2 text-left  font-mono text-xs text-text-muted uppercase tracking-wider whitespace-nowrap">PLATFORMS</th>
                                        <th className="px-3 py-2 text-right font-mono text-xs text-text-muted uppercase tracking-wider whitespace-nowrap">ROI GROSS</th>
                                        <th className="px-3 py-2 text-right font-mono text-xs text-text-muted uppercase tracking-wider whitespace-nowrap">ROI NET</th>
                                        <th className="px-3 py-2 text-right font-mono text-xs text-text-muted uppercase tracking-wider whitespace-nowrap">P/L $1K</th>
                                        <th className="px-3 py-2 text-center font-mono text-xs text-text-muted uppercase tracking-wider whitespace-nowrap">CONF</th>
                                        <th className="px-3 py-2 text-center font-mono text-xs text-text-muted uppercase tracking-wider whitespace-nowrap">URG</th>
                                        <th className="px-3 py-2 text-center font-mono text-xs text-text-muted uppercase tracking-wider whitespace-nowrap">RISK</th>
                                        <th className="px-3 py-2 text-center font-mono text-xs text-text-muted uppercase tracking-wider whitespace-nowrap">ACT</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredOpps.map((opp, idx) => {
                                        const isBest   = idx === 0 && sortBy === 'roi';
                                        const roiVal   = opp.roi;
                                        const netVal   = opp.net_roi ?? opp.roi;
                                        const urgColor = opp.urgency === 'high'   ? 'text-negative' : opp.urgency === 'medium' ? 'text-warning' : 'text-positive';
                                        const riskColor= opp.risk    === 'high'   ? 'text-negative' : opp.risk    === 'medium' ? 'text-warning' : 'text-positive';
                                        return (
                                            <tr
                                                key={idx}
                                                className="border-b border-border hover:bg-bg-elevated transition-colors duration-100"
                                            >
                                                {/* Opportunity title */}
                                                <td className="px-3 py-1.5">
                                                    <p className={`text-xs max-w-xs truncate ${isBest ? 'text-accent font-semibold' : 'text-text-primary'}`}>
                                                        {opp.title}
                                                    </p>
                                                </td>

                                                {/* Platform chips */}
                                                <td className="px-3 py-1.5">
                                                    <div className="flex flex-wrap gap-1">
                                                        {[opp.platform_a, opp.platform_b].filter(Boolean).map((p) => (
                                                            <span
                                                                key={p}
                                                                className="font-mono text-xs px-1.5 py-px bg-bg-elevated border border-border text-text-secondary uppercase rounded-sm leading-tight"
                                                            >
                                                                {p}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </td>

                                                {/* ROI gross */}
                                                <td className="px-3 py-1.5 text-right">
                                                    <span className={`font-mono text-xs font-bold ${isBest ? 'text-accent' : roiVal >= 0 ? 'text-positive' : 'text-negative'}`}>
                                                        {roiVal >= 0 ? '+' : ''}{roiVal.toFixed(2)}%
                                                    </span>
                                                </td>

                                                {/* ROI net */}
                                                <td className="px-3 py-1.5 text-right">
                                                    <span className={`font-mono text-xs ${netVal >= 0 ? 'text-positive' : 'text-negative'}`}>
                                                        {netVal >= 0 ? '+' : ''}{netVal.toFixed(2)}%
                                                    </span>
                                                </td>

                                                {/* P/L on $1K */}
                                                <td className="px-3 py-1.5 text-right">
                                                    <span className={`font-mono text-xs font-bold ${opp.profit_on_1000 >= 0 ? 'text-positive' : 'text-negative'}`}>
                                                        {opp.profit_on_1000 >= 0 ? '+' : ''}${opp.profit_on_1000.toFixed(1)}
                                                    </span>
                                                </td>

                                                {/* Confidence bar */}
                                                <td className="px-3 py-1.5 text-center">
                                                    <div className="flex items-center justify-center gap-1.5">
                                                        <div className="w-10 h-1 bg-bg-elevated rounded-sm overflow-hidden">
                                                            <div className="h-full bg-positive rounded-sm" style={{ width: `${opp.confidence}%` }} />
                                                        </div>
                                                        <span className="font-mono text-xs text-text-secondary">{opp.confidence}%</span>
                                                    </div>
                                                </td>

                                                {/* Urgency */}
                                                <td className="px-3 py-1.5 text-center">
                                                    <span className={`font-mono text-xs font-bold ${urgColor}`}>
                                                        {(opp.urgency || 'MED').toUpperCase().slice(0, 3)}
                                                    </span>
                                                </td>

                                                {/* Risk */}
                                                <td className="px-3 py-1.5 text-center">
                                                    <span className={`font-mono text-xs font-bold ${riskColor}`}>
                                                        {(opp.risk || 'MED').toUpperCase().slice(0, 3)}
                                                    </span>
                                                </td>

                                                {/* Action */}
                                                <td className="px-3 py-1.5 text-center">
                                                    <button className="px-2 py-0.5 border border-border text-text-secondary font-mono text-xs hover:border-accent hover:text-accent transition-colors duration-100 rounded-sm">
                                                        EXEC
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* ── Summary strip ────────────────────────────────── */}
                <div className="border border-border bg-bg-panel p-4 rounded-sm">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                            <div className="font-mono text-xs text-text-muted uppercase tracking-wider mb-1">BEST ROI</div>
                            <div className="font-mono text-2xl font-bold text-positive">{stats?.bestRoi.toFixed(2)}%</div>
                            <div className="font-mono text-xs text-text-muted mt-0.5 truncate">{filteredOpps[0]?.title?.slice(0, 50) || 'N/A'}</div>
                        </div>
                        <div>
                            <div className="font-mono text-xs text-text-muted uppercase tracking-wider mb-1">TOTAL PROFIT POTENTIAL</div>
                            <div className="font-mono text-2xl font-bold text-warning">{formatCurrency(stats?.totalProfitPotential || 0)}</div>
                            <div className="font-mono text-xs text-text-muted mt-0.5">ON $1K PER OPPORTUNITY</div>
                        </div>
                        <div>
                            <div className="font-mono text-xs text-text-muted uppercase tracking-wider mb-1">AVG CONFIDENCE</div>
                            <div className="font-mono text-2xl font-bold text-accent">
                                {opportunities.length > 0
                                    ? (opportunities.reduce((s, o) => s + o.confidence, 0) / opportunities.length).toFixed(0)
                                    : 0}%
                            </div>
                            <div className="font-mono text-xs text-text-muted mt-0.5">SIGNAL RELIABILITY</div>
                        </div>
                    </div>
                    <div className="mt-3 pt-3 border-t border-border font-mono text-xs text-text-muted">
                        REFRESH EVERY 30S &nbsp;|&nbsp; REAL-TIME DATA FROM AI MASTER AGENT &nbsp;|&nbsp; {filteredOpps.length} ACTIVE OPPORTUNITIES
                    </div>
                </div>

            </div>
        </div>
    );
}
