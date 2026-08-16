const https = require("https");
const fs = require("fs");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SENT_FILE = "/tmp/arb-alerts-sent.json";

let sentArbs = {};
if (fs.existsSync(SENT_FILE)) {
  try {
    sentArbs = JSON.parse(fs.readFileSync(SENT_FILE, "utf8"));
  } catch(e) {}
}

function saveSentArbs() {
  fs.writeFileSync(SENT_FILE, JSON.stringify(sentArbs, null, 2));
}

function sendTelegramAlert(opportunity) {
  const message = `🚨 ARBITRAGGIO TROVATO! 🚨

📊 Mercato: ${opportunity.question}
💰 ROI annuo: ${opportunity.roi_annual_pct}%
💵 Capacita: $${opportunity.capacity_usd}
📈 Spread: ${opportunity.spread_pct}%
🎯 Yes ask: ${opportunity.yes_ask}c | No ask: ${opportunity.no_ask}c
⏰ Rilevato: ${new Date().toLocaleTimeString()}`;

  const data = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: "Markdown"
  });

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const req = https.request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
    let resp = "";
    res.on("data", chunk => resp += chunk);
    res.on("end", () => console.error("Alert inviato, status:", res.statusCode));
  });
  req.on("error", (e) => console.error("Errore alert:", e.message));
  req.write(data);
  req.end();
}

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
        } catch(e) { resolve([]); }
      });
    });
    req.on("error", () => resolve([]));
    req.setTimeout(8000, () => resolve([]));
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
        } catch(e) { resolve([]); }
      });
    }).on("error", () => resolve([]));
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
        if (roiGross > 0.5 && roiGross < 20) {
          const opp = {
            question: question.substring(0, 100),
            type: "cashable",
            source: outcomes.yes.source,
            roi_annual_pct: (roiGross * 365).toFixed(1),
            capacity_usd: Math.min(outcomes.yes.bid * 100, outcomes.no.bid * 100) * 0.5,
            spread_pct: roiGross.toFixed(2),
            yes_ask: outcomes.yes.ask,
            no_ask: outcomes.no.ask
          };
          
          const key = opp.question + opp.spread_pct;
          if (!sentArbs[key]) {
            sendTelegramAlert(opp);
            sentArbs[key] = { timestamp: new Date().toISOString() };
            saveSentArbs();
          }
          
          opportunities.push(opp);
        }
      }
    }
  }
  
  return opportunities;
}

async function main() {
  console.error("🔍 SCANSIONE CON ALERT...");
  const [kalshi, polymarket] = await Promise.all([fetchKalshi(), fetchPolymarket()]);
  const allMarkets = [...kalshi, ...polymarket];
  const opportunities = await findArbitrage(allMarkets);
  
  const output = {
    timestamp: new Date().toISOString(),
    sources: { kalshi: kalshi.length, polymarket: polymarket.length },
    cashable_found: opportunities.length,
    opportunities: opportunities,
    message: opportunities.length === 0 ? "Nessun arb cashable — mercati efficienti" : "Arb trovati! Alert Telegram inviati."
  };
  
  console.log(JSON.stringify(output, null, 2));
}

main();
