import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const response = await fetch('https://api.manifold.markets/v0/markets?limit=50&sort=liquidity');
        const data = await response.json();
        
        const markets = (Array.isArray(data) ? data : [])
            .filter((m: any) => m.outcomeType === 'BINARY' && !m.isResolved)
            .map((m: any) => ({
                id: m.id,
                title: m.question || 'Unknown',
                platform: 'Manifold',
                category: m.category || 'General',
                yesPrice: Math.round((m.probability || 0.5) * 100),
                noPrice: 100 - Math.round((m.probability || 0.5) * 100),
                volume: Math.round(parseFloat(m.volume || '0') / 1000),
                endDate: m.closeTime ? new Date(m.closeTime).toISOString().split('T')[0] : '2024-12-31',
                fee: 0,
                url: m.url || `https://manifold.markets/${m.slug}`,
                lastUpdated: Date.now()
            }));
        
        return NextResponse.json({ success: true, markets, count: markets.length });
    } catch (error) {
        return NextResponse.json({ success: false, markets: [], error: String(error) });
    }
}
