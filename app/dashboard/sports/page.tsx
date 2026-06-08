'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function SportsPage() {
    const [events, setEvents] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/sports').then(res => res.json()).then(data => {
            setEvents(data.events || []);
            setLoading(false);
        }).catch(() => setLoading(false));
    }, []);

    if (loading) return <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-500">Caricamento...</div>;

    return (
        <div className="min-h-screen bg-gray-950">
            <header className="border-b border-gray-800 bg-gray-900/50 px-4 py-4 sticky top-0">
                <div className="max-w-7xl mx-auto flex justify-between items-center">
                    <div><h1 className="text-xl font-bold text-white">⚽ Sports Arbitrage</h1><p className="text-xs text-gray-500">40+ bookmakers • NFL • NBA • Soccer • Tennis</p></div>
                    <Link href="/dashboard" className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 text-sm">← Dashboard</Link>
                </div>
            </header>
            <div className="max-w-7xl mx-auto px-4 py-6">
                <div className="grid grid-cols-1 gap-4">
                    {events.map((event: any, i) => (
                        <div key={i} className="rounded-xl border border-gray-800 bg-gray-900/30 p-4">
                            <div className="flex justify-between"><span className="px-2 py-0.5 rounded text-xs bg-green-500/20 text-green-400">{event.league}</span><span className="text-xs text-gray-500">Live Odds</span></div>
                            <h3 className="text-lg font-bold text-white mt-2">{event.home} vs {event.away}</h3>
                            <div className="grid grid-cols-3 gap-3 mt-3 text-center">
                                <div className="bg-gray-800/50 rounded-lg p-2"><div className="text-xs text-gray-500">HOME</div><div className="text-xl font-bold text-green-400">{event.odds.home}</div></div>
                                {event.odds.draw && <div className="bg-gray-800/50 rounded-lg p-2"><div className="text-xs text-gray-500">DRAW</div><div className="text-xl font-bold text-yellow-400">{event.odds.draw}</div></div>}
                                <div className="bg-gray-800/50 rounded-lg p-2"><div className="text-xs text-gray-500">AWAY</div><div className="text-xl font-bold text-blue-400">{event.odds.away}</div></div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
