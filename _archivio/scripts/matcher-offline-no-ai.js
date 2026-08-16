const https = require('https');

async function fetchKalshiMarkets() {
    return new Promise((resolve) => {
        const req = https.get('https://trading-api.kalshi.com/trade-api/v2/markets?limit=100', {
            headers: { 'Authorization': 'Bearer ' + (process.env.KALSHI_API_KEY || '') }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.markets || []);
                } catch(e) { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.setTimeout(5000, () => resolve([]));
    });
}

async function fetchPolymarketMarkets() {
    return new Promise((resolve) => {
        https.get('https://clob.polymarket.com/markets', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    // Polymarket ritorna array o oggetto? Controlliamo
                    const markets = Array.isArray(parsed) ? parsed : (parsed.markets || parsed.data || []);
                    resolve(markets);
                } catch(e) { resolve([]); }
            });
        }).on('error', () => resolve([]));
    });
}

async function fetchFutuurMarkets() {
    return new Promise((resolve) => {
        https.get('https://api.futuur.com/api/v1/markets', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.results || []);
                } catch(e) { resolve([]); }
            });
        }).on('error', () => resolve([]));
    });
}

function findArbitrage(markets) {
    const opportunities = [];
    const byQuestion = {};
    
    for (const m of markets) {
        if (!m) continue;
        const question = m.question || m.title || m.name;
        if (!question) continue;
        
        const outcome = (m.outcome || m.condition || '').toLowerCase();
        const bid = parseFloat(m.bid_price || m.bestBid || m.close || 0);
        const ask = parseFloat(m.ask_price || m.bestAsk || 0);
        
        if (!byQuestion[question]) byQuestion[question] = {};
        if (outcome.includes('yes')) byQuestion[question].yes = { bid, ask, source: m.source || 'unknown' };
        if (outcome.includes('no')) byQuestion[question].no = { bid, ask, source: m.source || 'unknown' };
    }
    
    for (const [question, outcomes] of Object.entries(byQuestion)) {
        if (outcomes.yes && outcomes.no && outcomes.yes.ask > 0 && outcomes.no.ask > 0) {
            const totalCost = outcomes.yes.ask + outcomes.no.ask;
            if (totalCost >= 100) continue;
            
            const roiGross = (100 - totalCost) / totalCost * 100;
            if (roiGross < 0.5 || roiGross > 15) continue;
            
            opportunities.push({
                question,
                type: 'cashable',
                source: outcomes.yes.source,
                roi_annual_pct: roiGross * 365,
                capacity_usd: Math.min(outcomes.yes.bid * 100, outcomes.no.bid * 100) * 0.3,
                details: { yes_ask: outcomes.yes.ask, no_ask: outcomes.no.ask, roi_gross: roiGross }
            });
        }
    }
    
    return opportunities;
}

async function main() {
    console.error('🔄 Scansione offline...');
    
    const [kalshiRaw, polymarketRaw, futuurRaw] = await Promise.all([
        fetchKalshiMarkets(),
        fetchPolymarketMarkets(),
        fetchFutuurMarkets()
    ]);
    
    // Marca la fonte
    const kalshi = kalshiRaw.map(m => ({ ...m, source: 'Kalshi' }));
    const polymarket = (Array.isArray(polymarketRaw) ? polymarketRaw : []).map(m => ({ ...m, source: 'Polymarket' }));
    const futuur = (Array.isArray(futuurRaw) ? futuurRaw : []).map(m => ({ ...m, source: 'Futuur' }));
    
    const allMarkets = [...kalshi, ...polymarket, ...futuur];
    const opportunities = findArbitrage(allMarkets);
    
    const output = {
        timestamp: new Date().toISOString(),
        markets_scanned: allMarkets.length,
        sources: { kalshi: kalshi.length, polymarket: polymarket.length, futuur: futuur.length },
        cashable_found: opportunities.length,
        opportunities: opportunities
    };
    
    console.log(JSON.stringify(output, null, 2));
}

main().catch(e => {
    console.error('Fatal:', e.message);
    console.log(JSON.stringify({ error: e.message, timestamp: new Date().toISOString(), cashable_found: 0, opportunities: [] }));
});
