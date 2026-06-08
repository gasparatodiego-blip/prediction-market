import { NextResponse } from 'next/server';
import fs from 'fs';

export async function GET() {
    try {
        const polymarket = JSON.parse(fs.readFileSync('/tmp/polymarket-raw.json', 'utf8') || '{"markets":[]}');
        const kalshi = JSON.parse(fs.readFileSync('/tmp/kalshi-raw.json', 'utf8') || '{"markets":[]}');
        
        const markets = [
            ...(polymarket.markets || []).slice(0, 20).map((m: any) => ({
                id: m.id,
                title: m.question || 'Unknown',
                platform: 'Polymarket',
                price: m.outcomePrices ? JSON.parse(m.outcomePrices)[0] * 100 : 50,
                volume: m.volume24hr || 0,
                url: m.slug ? `https://polymarket.com/event/${m.slug}` : null
            })),
            ...(kalshi.markets || []).slice(0, 20).map((m: any) => ({
                id: m.ticker,
                title: m.title || 'Unknown',
                platform: 'Kalshi',
                price: m.yes_bid_dollars ? m.yes_bid_dollars * 100 : 50,
                volume: m.volume || 0,
                url: `https://kalshi.com/markets/${m.ticker}`
            }))
        ];
        
        return NextResponse.json({ success: true, markets, timestamp: Date.now() });
    } catch {
        return NextResponse.json({ success: true, markets: [], timestamp: Date.now() });
    }
}
