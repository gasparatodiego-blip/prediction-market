// NOTE: the 'Polymarket': 0.02 flat "winnings" fee was removed — it is unverified and does not exist
// under CLOB v2 (fees are taker-only, per-market, applied at match time; see lib/polymarket-fees.js).
// The real Polymarket taker fee is applied at the executable-price layer (lib/arb-math.js), not as a
// flat winnings fraction here. Kept 0 rather than deleting the key so callers reading the map still
// resolve a number (0), never undefined.
export const PLATFORM_FEES: Record<string, number> = {
    'Polymarket': 0.00,
    'Kalshi': 0.07,
    'PredictIt': 0.10,
    'Manifold': 0.00
};

export const PLATFORM_ICONS: Record<string, string> = {
    'Polymarket': '🟣',
    'Kalshi': '🔵',
    'PredictIt': '🟠',
    'Manifold': '🟢'
};

export function calculateNetProfit(amount: number, totalCost: number, feeA: number, feeB: number) {
    const grossProfit = amount * (100 - totalCost) / 100;
    const netProfit = grossProfit * (1 - (feeA + feeB));
    const roi = (netProfit / amount) * 100;
    return {
        invested: amount,
        totalSpent: (amount * totalCost / 100).toFixed(2),
        grossProfit: grossProfit.toFixed(2),
        totalFees: (grossProfit - netProfit).toFixed(2),
        netProfit: netProfit.toFixed(2),
        roi: roi.toFixed(2)
    };
}

export function findArbitrageOpportunities(markets: any[]): any[] {
    const opportunities: any[] = [];
    for (let i = 0; i < markets.length; i++) {
        for (let j = i + 1; j < markets.length; j++) {
            const a = markets[i];
            const b = markets[j];
            if (a.platform === b.platform) continue;
            const total1 = a.yesPrice + b.noPrice;
            if (total1 < 100) {
                opportunities.push({
                    id: `${Date.now()}-${i}-${j}-1`,
                    event: a.title,
                    buyYesOn: a.platform,
                    buyYesPrice: a.yesPrice,
                    buyYesFee: a.fee,
                    buyNoOn: b.platform,
                    buyNoPrice: b.noPrice,
                    buyNoFee: b.fee,
                    totalCost: total1,
                    spread: (100 - total1).toFixed(2),
                    profitPer100: calculateNetProfit(100, total1, a.fee, b.fee)
                });
            }
            const total2 = b.yesPrice + a.noPrice;
            if (total2 < 100) {
                opportunities.push({
                    id: `${Date.now()}-${i}-${j}-2`,
                    event: a.title,
                    buyYesOn: b.platform,
                    buyYesPrice: b.yesPrice,
                    buyYesFee: b.fee,
                    buyNoOn: a.platform,
                    buyNoPrice: a.noPrice,
                    buyNoFee: a.fee,
                    totalCost: total2,
                    spread: (100 - total2).toFixed(2),
                    profitPer100: calculateNetProfit(100, total2, b.fee, a.fee)
                });
            }
        }
    }
    return opportunities.sort((a, b) => parseFloat(b.spread) - parseFloat(a.spread));
}

export function getOpportunityBadge(spread: number) {
    if (spread >= 1.5) return { label: `🔥 ARBITRAGGIO +${spread}%`, color: 'red', bgColor: 'bg-red-600', textColor: 'text-white' };
    if (spread >= 0.8) return { label: `⚠️ ARBITRAGGIO +${spread}%`, color: 'yellow', bgColor: 'bg-yellow-500', textColor: 'text-black' };
    if (spread >= 0.5) return { label: `ℹ️ ARBITRAGGIO +${spread}%`, color: 'blue', bgColor: 'bg-blue-600', textColor: 'text-white' };
    return { label: '⚪ Nessuna Opp', color: 'gray', bgColor: 'bg-gray-600', textColor: 'text-white' };
}
