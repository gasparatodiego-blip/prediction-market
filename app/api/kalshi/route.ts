import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const response = await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?limit=50&status=open');
        const data = await response.json();
        
        const markets = (data.markets || []).map((m: any) => ({
            id: m.ticker,
            title: m.title || m.subtitle || 'Unknown',
            platform: 'Kalshi',
            category: 'Politics',
            yesPrice: (() => {
                const ask = parseFloat(m.yes_ask_dollars || '0');
                const bid = parseFloat(m.yes_bid_dollars || '0');
                if (ask > 0) return Math.round(ask * 100);
                if (bid > 0) return Math.round(bid * 100);
                return 50;
            })(),
            noPrice: (() => {
                const ask = parseFloat(m.no_ask_dollars || '0');
                const bid = parseFloat(m.no_bid_dollars || '0');
                if (ask > 0) return Math.round(ask * 100);
                if (bid > 0) return Math.round(bid * 100);
                return 50;
            })(),
            volume: Math.round(parseFloat(m.volume || '0') / 1000),
            endDate: m.close_time?.split('T')[0] || '2024-12-31',
            fee: 0,
            url: `https://kalshi.com/markets/${m.ticker}`,
            lastUpdated: Date.now()
        }));
        
        return NextResponse.json({ success: true, markets, count: markets.length });
    } catch (error) {
        return NextResponse.json({ success: false, markets: [], error: String(error) });
    }
}
