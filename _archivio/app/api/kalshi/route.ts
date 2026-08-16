import { NextResponse } from 'next/server';

export async function GET() {
    try {
        // Kalshi's real category lives on the EVENT (the /markets endpoint returns
        // category:null), so read events with nested markets and carry ev.category
        // down to each market. Honest passthrough — absent category stays 'other'.
        const response = await fetch('https://api.elections.kalshi.com/trade-api/v2/events?limit=50&status=open&with_nested_markets=true');
        const data = await response.json();

        const flat = (data.events || []).flatMap((ev: any) =>
            (ev.markets || []).map((m: any) => ({ ...m, _category: ev.category, _eventTitle: ev.title })),
        );

        const markets = flat.map((m: any) => ({
            id: m.ticker,
            title: m.title || m.yes_sub_title || m._eventTitle || 'Unknown',
            platform: 'Kalshi',
            category: m._category || 'other',
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
