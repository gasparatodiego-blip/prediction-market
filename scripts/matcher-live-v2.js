const https = require("https");

async function fetchKalshi() {
  return new Promise((resolve) => {
    const req = https.get("https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&status=open", {
      timeout: 8000,
      headers: { "Accept": "application/json" }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const markets = json.markets || [];
          console.error("📡 Kalshi: " + markets.length + " mercati");
          resolve(markets.map(m => ({ ...m, source: "Kalshi" })));
        } catch(e) { 
          console.error("Kalshi parse error:", e.message); 
          resolve([]); 
        }
      });
    });
    req.on("error", (e) => { 
      console.error("Kalshi error:", e.message); 
      resolve([]); 
    });
    req.setTimeout(8000, () => { 
      console.error("Kalshi timeout"); 
      resolve([]); 
    });
  });
}

async function fetchPolymarket() {
  return new Promise((resolve) => {
    https.get("https://clob.polymarket.com/markets", { timeout: 8000 }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          let parsed = JSON.parse(data);
          let markets = Array.isArray(parsed) ? parsed : (parsed.data || parsed.markets || []);
          console.error("📡 Polymarket: " + markets.length + " mercati");
          resolve(markets.slice(0, 500).map(m => ({ ...m, source: "Polymarket" })));
        } catch(e) { 
          console.error("Polymarket parse error"); 
          resolve([]); 
        }
      });
    }).on("error", (e) => { 
      console.error("Polymarket error:", e.message); 
      resolve([]); 
    });
  });
}

async function findArbitrage(markets) {
  const byQuestion = {};
  
  for (const m of markets) {
    const question = m.question || m.title || m.name;
    if (!question) continue;
    
    const outcome = (m.outcome || m.condition || m.ticker || "").toLowerCase();
    const bid = parseFloat(m.bid_price || m.bestBid || m.bid || 0);
    const ask = parseFloat(m.ask_price || m.bestAsk || m.ask || 0);
    
    if (!byQuestion[question]) byQuestion[question] = {};
    if (outcome.includes("yes")) byQuestion[question].yes = { bid, ask, source: m.source };
    if (outcome.includes("no")) byQuestion[question].no = { bid, ask, source: m.source };
  }
  
  const opportunities = [];
  
  for (const [question, outcomes] of Object.entries(byQuestion)) {
    if (outcomes.yes && outcomes.no && outcomes.yes.ask > 0 && outcomes.no.ask > 0) {
      const totalCost = outcomes.yes.ask + outcomes.no.ask;
      if (totalCost < 100 && totalCost > 0) {
        const roiGross = (100 - totalCost) / totalCost * 100;
        if (roiGross > 0.2 && roiGross < 20) {
          opportunities.push({
            question: question.substring(0, 100),
            type: "cashable",
            source: outcomes.yes.source,
            roi_annual_pct: (roiGross * 365).toFixed(1),
            capacity_usd: Math.min(outcomes.yes.bid * 100, outcomes.no.bid * 100) * 0.5,
            spread_pct: roiGross.toFixed(2),
            yes_ask: outcomes.yes.ask,
            no_ask: outcomes.no.ask
          });
        }
      }
    }
  }
  
  return opportunities;
}

async function main() {
  console.error("🔍 SCANSIONE LIVE v2 (Kalshi Elections API)...");
  const [kalshi, polymarket] = await Promise.all([fetchKalshi(), fetchPolymarket()]);
  const allMarkets = [...kalshi, ...polymarket];
  const opportunities = await findArbitrage(allMarkets);
  
  const output = {
    timestamp: new Date().toISOString(),
    sources: { kalshi: kalshi.length, polymarket: polymarket.length },
    cashable_found: opportunities.length,
    opportunities: opportunities,
    message: opportunities.length === 0 ? "Nessun arb cashable al momento — i mercati sono efficienti" : "Arb trovati! Verifica capacity prima di tradare."
  };
  
  console.log(JSON.stringify(output, null, 2));
}

main();
