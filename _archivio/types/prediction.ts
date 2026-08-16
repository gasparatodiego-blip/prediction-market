export interface NormalizedMarket {
    id: string;
    title: string;
    platform: string;
    category: string;
    yesPrice: number;
    noPrice: number;
    volume24h: number;
    liquidity: number;
    endDate: string;
    fee: number;
    url: string;
    lastUpdated: number;
}

export interface ArbitrageOpportunity {
    id: string;
    event: string;
    buyYesOn: string;
    buyYesPrice: number;
    buyYesFee: number;
    buyNoOn: string;
    buyNoPrice: number;
    buyNoFee: number;
    totalCost: number;
    spread: number;
    profitPer100: {
        invested: number;
        totalSpent: string;
        grossProfit: string;
        totalFees: string;
        netProfit: string;
        roi: string;
    };
    type: string;
}
