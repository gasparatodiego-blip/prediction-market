'use client';

import { useState } from 'react';

export default function SportsPage() {
    const [events] = useState([
        { id: 1, league: 'NBA', home: 'Lakers', away: 'Celtics', oddsHome: 2.10, oddsAway: 1.80 },
        { id: 2, league: 'NFL', home: 'Chiefs', away: '49ers', oddsHome: 1.85, oddsAway: 2.05 },
    ]);

    return (
        <div>
            <div className="max-w-7xl mx-auto p-4">
                <div className="grid grid-cols-1 gap-4">
                    {events.map(event => (
                        <div key={event.id} className="bg-gray-900/40 rounded-xl border border-gray-800 p-4">
                            <div className="flex justify-between"><span className="px-2 py-0.5 rounded text-xs bg-green-500/20 text-green-400">{event.league}</span></div>
                            <h3 className="font-semibold text-white text-center my-2">{event.home} vs {event.away}</h3>
                            <div className="grid grid-cols-2 gap-4 text-center">
                                <div className="bg-gray-800/50 rounded-lg p-2"><div className="text-xs text-gray-400">HOME</div><div className="text-xl font-bold text-green-400">{event.oddsHome}</div></div>
                                <div className="bg-gray-800/50 rounded-lg p-2"><div className="text-xs text-gray-400">AWAY</div><div className="text-xl font-bold text-blue-400">{event.oddsAway}</div></div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
