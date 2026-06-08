import { NextResponse } from 'next/server';

export async function GET() {
    const sports = [
        { league: 'NFL', home: 'Kansas City Chiefs', away: 'San Francisco 49ers', odds: { home: 1.85, away: 2.05 } },
        { league: 'NBA', home: 'Los Angeles Lakers', away: 'Boston Celtics', odds: { home: 2.10, away: 1.80 } },
        { league: 'Soccer', home: 'Real Madrid', away: 'Barcelona', odds: { home: 2.30, away: 2.80, draw: 3.40 } },
        { league: 'Tennis', home: 'Carlos Alcaraz', away: 'Novak Djokovic', odds: { home: 1.95, away: 1.95 } }
    ];
    return NextResponse.json({ success: true, events: sports, timestamp: Date.now() });
}
