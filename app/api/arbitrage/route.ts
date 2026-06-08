import { NextResponse } from 'next/server';
import fs from 'fs';

export async function GET() {
    try {
        const arbData = JSON.parse(fs.readFileSync('/tmp/arbitrage-opportunities.json', 'utf8'));
        const masterData = JSON.parse(fs.readFileSync('/tmp/master-opportunities.json', 'utf8'));
        
        const opportunities = (arbData.opportunities || []).map((opp: any) => ({
            id: opp.id,
            title: opp.title,
            type: opp.type,
            platform_a: opp.platform_a,
            platform_b: opp.platform_b,
            price_a: opp.price_a,
            price_b: opp.price_b,
            roi: opp.roi || 0,
            net_roi: opp.net_profit ? (opp.net_profit / 10) : opp.roi,
            confidence: opp.confidence || 70,
            profit_on_1000: opp.net_profit || (opp.roi * 10),
            urgency: opp.urgency || 'medium',
            risk: opp.risk || 'medium',
            description: opp.description
        }));
        
        return NextResponse.json({
            success: true,
            opportunities,
            master: masterData,
            timestamp: Date.now()
        });
    } catch (error) {
        return NextResponse.json({
            success: false,
            opportunities: [],
            error: String(error)
        });
    }
}
