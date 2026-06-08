import { NextResponse } from 'next/server';
import fs from 'fs';

export async function GET() {
    try {
        const statsRaw = fs.readFileSync('/tmp/hft-5min-stats.json', 'utf8');
        const stateRaw = fs.readFileSync('/tmp/hft-5min-state.json', 'utf8');
        const signalsRaw = fs.readFileSync('/tmp/hft-5min-signals.json', 'utf8');
        
        const stats = JSON.parse(statsRaw);
        const state = JSON.parse(stateRaw);
        const signals = JSON.parse(signalsRaw);
        
        // Prezzi di mercato simulati
        const markets = [
            { symbol: 'BTCUSDT', name: 'Bitcoin', price: 94000 + (Math.random() - 0.5) * 1000, change: (Math.random() - 0.5) * 2 },
            { symbol: 'ETHUSDT', name: 'Ethereum', price: 3200 + (Math.random() - 0.5) * 50, change: (Math.random() - 0.5) * 3 },
            { symbol: 'SOLUSDT', name: 'Solana', price: 180 + (Math.random() - 0.5) * 5, change: (Math.random() - 0.5) * 4 },
            { symbol: 'BNBUSDT', name: 'BNB', price: 580 + (Math.random() - 0.5) * 10, change: (Math.random() - 0.5) * 2.5 },
            { symbol: 'XRPUSDT', name: 'XRP', price: 0.52 + (Math.random() - 0.5) * 0.03, change: (Math.random() - 0.5) * 5 },
            { symbol: 'DOGEUSDT', name: 'Dogecoin', price: 0.12 + (Math.random() - 0.5) * 0.01, change: (Math.random() - 0.5) * 6 }
        ];
        
        return NextResponse.json({
            success: true,
            stats,
            positions: state.positions || [],
            signals: signals.signals || [],
            markets,
            lastUpdate: new Date().toISOString()
        });
    } catch (error) {
        return NextResponse.json({
            success: false,
            error: String(error),
            stats: null,
            positions: [],
            signals: [],
            markets: []
        });
    }
}
