import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

export async function GET() {
    try {
        const positionsRaw = fs.readFileSync('/tmp/liquidity-positions.json', 'utf8');
        const historyRaw = fs.readFileSync('/tmp/liquidity-history.json', 'utf8');
        const polymarketRaw = fs.readFileSync('/tmp/polymarket-raw.json', 'utf8');
        
        const positions = JSON.parse(positionsRaw);
        const history = JSON.parse(historyRaw);
        const polymarket = JSON.parse(polymarketRaw);
        
        // Calcola statistiche
        const activePositions = positions.filter((p: any) => p.status === 'active');
        const totalExposure = activePositions.reduce((s: number, p: any) => s + (p.amountUSD || 0), 0);
        const totalFees = activePositions.reduce((s: number, p: any) => s + (p.feesEarned || 0), 0);
        const avgAPY = activePositions.length > 0 
            ? activePositions.reduce((s: number, p: any) => s + (p.estimatedAPY || 0), 0) / activePositions.length 
            : 0;
        
        // Cerca mercati candidati
        const candidates = [];
        if (polymarket?.markets) {
            for (const market of polymarket.markets.slice(0, 10)) {
                let price = null;
                try {
                    const prices = typeof market.outcomePrices === 'string' 
                        ? JSON.parse(market.outcomePrices) 
                        : market.outcomePrices;
                    if (Array.isArray(prices) && prices[0]) {
                        price = parseFloat(prices[0]) * 100;
                    }
                } catch {}
                if (price && price > 35 && price < 65) {
                    candidates.push({
                        id: market.id,
                        question: market.question?.slice(0, 80),
                        price: Math.round(price),
                        volume24h: market.volume24hr || market.volume || 0,
                        url: market.slug ? `https://polymarket.com/event/${market.slug}` : null
                    });
                }
            }
        }
        
        const session = await getServerSession(authOptions);
        const isPaid  = await getIsPaid(session);

        const body = redactForTier({
            success: true,
            positions: activePositions,
            history: history.trades?.slice(-20) || [],
            summary: {
                totalExposure,
                totalFees,
                avgAPY: Math.round(avgAPY),
                activeCount: activePositions.length,
                maxPositions: 5,
                maxExposure: 10000,
                remainingCapital: 10000 - totalExposure
            },
            candidates: candidates.slice(0, 5),
            lastUpdate: new Date().toISOString()
        }, 'lp', isPaid);

        return NextResponse.json(body);
    } catch (error) {
        return NextResponse.json({
            success: false,
            error: String(error),
            positions: [],
            history: [],
            summary: null
        });
    }
}
