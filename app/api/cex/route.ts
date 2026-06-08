import { NextResponse } from 'next/server';

export async function GET() {
    const exchanges = ['Binance', 'Coinbase', 'Kraken', 'Bybit', 'OKX', 'Gate.io'];
    const coins = ['BTC', 'ETH', 'SOL'];
    const prices: any = {};
    
    for (const exchange of exchanges) {
        prices[exchange] = {};
        for (const coin of coins) {
            const basePrice = coin === 'BTC' ? 94300 : coin === 'ETH' ? 3200 : 180;
            prices[exchange][coin] = basePrice * (1 + (Math.random() - 0.5) * 0.008);
        }
    }
    
    return NextResponse.json({ success: true, prices, timestamp: Date.now() });
}
