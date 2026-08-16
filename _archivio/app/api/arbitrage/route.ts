import { NextResponse } from 'next/server';
import { findArbitrageOpportunities } from '@/lib/arbitrage';

export async function GET() {
    try {
        const [polymarket, kalshi, predictit, manifold] = await Promise.all([
            fetch('http://localhost:3000/api/polymarket').then(r => r.json()).catch(() => ({ markets: [] })),
            fetch('http://localhost:3000/api/kalshi').then(r => r.json()).catch(() => ({ markets: [] })),
            fetch('http://localhost:3000/api/predictit').then(r => r.json()).catch(() => ({ markets: [] })),
            fetch('http://localhost:3000/api/manifold').then(r => r.json()).catch(() => ({ markets: [] }))
        ]);
        
        const allMarkets = [
            ...(polymarket.markets || []),
            ...(kalshi.markets || []),
            ...(predictit.markets || []),
            ...(manifold.markets || [])
        ];
        
        const opportunities = findArbitrageOpportunities(allMarkets);
        
        return NextResponse.json({ success: true, opportunities, count: opportunities.length });
    } catch (error) {
        return NextResponse.json({ success: false, opportunities: [], error: String(error) });
    }
}
