import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const response = await fetch('https://www.predictit.org/api/marketdata/all/');
        const data = await response.json();
        
        const markets = (data.markets || []).slice(0, 30).map((m: any) => {
            const contracts = m.contracts || [];
            const yesC = contracts.find((c: any) => c.name === 'Yes');
            const noC = contracts.find((c: any) => c.name === 'No');
            return {
                id: String(m.id),
                title: m.name || m.shortName || 'Unknown',
                platform: 'PredictIt',
                category: 'Politics',
                yesPrice: yesC ? Math.round((yesC.lastTradePrice || 0.5) * 100) : 50,
                noPrice: noC ? Math.round((noC.lastTradePrice || 0.5) * 100) : 50,
                volume: Math.round((parseFloat(m.volume || '0')) / 1000),
                endDate: m.endDate?.split('T')[0] || '2024-12-31',
                fee: 10,
                url: m.url || `https://www.predictit.org/markets/detail/${m.id}`,
                lastUpdated: Date.now()
            };
        });
        
        return NextResponse.json({ success: true, markets, count: markets.length });
    } catch (error) {
        return NextResponse.json({ success: false, markets: [], error: String(error) });
    }
}
