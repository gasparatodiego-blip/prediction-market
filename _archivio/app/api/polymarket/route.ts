import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const response = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50', {
            headers: { 'Accept': 'application/json' }
        });
        const data = await response.json();
        
        const markets = (Array.isArray(data) ? data : []).filter((m: any) => m.active).map((m: any) => ({
            id: m.id,
            title: m.question || m.title || 'Unknown',
            platform: 'Polymarket',
            category: m.category || 'Crypto',
            yesPrice: (() => {
                try {
                    const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
                    const yes = parseFloat(prices?.[0] || '0.5');
                    return Math.round(yes * 100);
                } catch { return 50; }
            })(),
            noPrice: (() => {
                try {
                    const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
                    const yes = parseFloat(prices?.[0] || '0.5');
                    return 100 - Math.round(yes * 100);
                } catch { return 50; }
            })(),
            volume: Math.round(parseFloat(m.volume24hr || '0') / 1000),
            endDate: m.endDate || '2024-12-31',
            fee: 2,
            url: m.slug ? `https://polymarket.com/event/${m.slug}` : '#',
            lastUpdated: Date.now()
        }));
        
        return NextResponse.json({ success: true, markets, count: markets.length });
    } catch (error) {
        return NextResponse.json({ success: false, markets: [], error: String(error) });
    }
}
