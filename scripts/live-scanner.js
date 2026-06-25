const https = require("https");
const fs = require("fs");

async function fetchAPI(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json.markets || json.data || json.results || []);
        } catch(e) { resolve([]); }
      });
    });
    req.on("error", () => resolve([]));
    req.setTimeout(8000, () => resolve([]));
  });
}

async function main() {
  console.error("🔍 Scanning Kalshi & Polymarket...");
  
  const [kalshi, polymarket] = await Promise.all([
    fetchAPI("https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&status=open"),
    fetchAPI("https://clob.polymarket.com/markets")
  ]);
  
  const output = {
    timestamp: new Date().toISOString(),
    kalshi_markets: kalshi.length,
    polymarket_markets: polymarket.length,
    arbitrages_found: 0,
    opportunities: []
  };
  
  // Salva in entrambi i percorsi
  fs.writeFileSync("public/latest-opportunities.json", JSON.stringify(output, null, 2));
  fs.writeFileSync(".next/server/public/latest-opportunities.json", JSON.stringify(output, null, 2));
  
  console.log(JSON.stringify(output));
  console.error("✅ Scan completato!");
}

main().catch(e => {
  console.error("Errore:", e.message);
  const fallback = { timestamp: new Date().toISOString(), error: e.message };
  fs.writeFileSync("public/latest-opportunities.json", JSON.stringify(fallback, null, 2));
});
