# Project Status — 2026-06-05

## Agents (pm2)

### Currently RUNNING

| pm2 id | Name | Purpose | Output |
|--------|------|---------|--------|
| 1 | dashboard | Next.js 14 frontend on port 3000 | serves http://localhost:3000 |
| 3 | agent-fetcher | Fetches PredictIt + Manifold every 60s | `/tmp/markets-raw.json` |
| 6 | agent-calculator | Calculates classic cross-platform arbitrage | `/tmp/matches-*.json` |
| 12 | agent10-binance | WebSocket price feed (Binance/Bybit/OKX), funding rates, CEX arb | `/tmp/exchange-prices.json` |
| 17 | agent-master | AI master agent (Claude claude-sonnet-4-6) — analyzes all data every 30min, ranks top 5 opportunities | `/tmp/arbitrage-opportunities.json`, `/tmp/master-opportunities.json` |
| 18 | agent-kalshi | Fetches Kalshi public markets every 5min | `/tmp/kalshi-raw.json` |
| 19 | agent-polymarket | Fetches Polymarket active markets every 5min (3 pages × 100) | `/tmp/polymarket-raw.json` |

### Currently STOPPED

| pm2 id | Name | Purpose | Why Stopped |
|--------|------|---------|-------------|
| 0 | proxy-eu | EU reverse proxy | crash loop (5 restarts) |
| 2 | agent-orchestrator | Monitors agents, restarts stuck ones | stopped — needs manual restart |
| 4 | agent-matcher-politics | AI matcher for political markets (legacy pipeline) | stopped |
| 5, 9 | agent-matcher-other | AI matcher for sports/crypto markets (legacy pipeline) | stopped (duplicate entries) |
| 7 | agent-ui-updater | Keeps `/tmp/ui-data.json` fresh | stopped |
| 8 | agent-matcher-3 | Crypto matcher variant | stopped |
| 10 | agent-sentiment | Sentiment analysis | stopped |
| 11 | agent-telegram | Telegram alert bot | stopped (2 restart failures) |
| 13 | agent11-dex | DEX price fetcher | stopped |
| 14 | agent-sports | Sports odds via The Odds API | stopped |
| 15 | agent-weather | Weather market fetcher (Kalshi weather + Open-Meteo) | stopped |
| 16 | agent14-rebalancer | Delta-neutral rebalancer (funding rate positions) | stopped |

---

## Data Sources

### WORKING (fresh data in /tmp/)

| File | Age at audit | Content |
|------|-------------|---------|
| `/tmp/kalshi-raw.json` | <1 min | 100 Kalshi markets, 87 priced |
| `/tmp/polymarket-raw.json` | <1 min | 300 Polymarket markets, 85 active with prices |
| `/tmp/exchange-prices.json` | ~28 min | Binance/Bybit/OKX spot prices + perpetual funding rates for BTC/ETH/BNB/XRP/SOL/DOGE |
| `/tmp/arbitrage-opportunities.json` | ~3 hr | 5 AI-ranked opportunities from master agent |
| `/tmp/master-opportunities.json` | ~3 hr | Full master agent output with fear/greed context |
| `/tmp/odds-api-raw.json` | ~3 hr | Sports odds from The Odds API |
| `/tmp/sentiment-data.json` | present | Market sentiment data |
| `/tmp/weather-markets.json` | present | Weather prediction markets |
| `/tmp/sports-odds.json` | present | Sports odds cache |
| `/tmp/rebalancer-output.json` | present | Delta-neutral position recommendations |

### STALE / NOT REFRESHING

| File | Issue |
|------|-------|
| `/tmp/markets-raw.json` | Last updated Jun 5 05:43 — agent-fetcher just restarted, will refresh soon |
| `/tmp/agent-status.json` | Last updated Jun 4 15:30 — agent-orchestrator is stopped |
| `/tmp/ui-data.json` | Last updated Jun 5 18:18 — agent-ui-updater is stopped |

---

## Dashboard Status

- **URL**: http://localhost:3000
- **Status**: ONLINE (Next.js 14, pm2 id 1)
- **API `/api/markets`**: Serving all 4 prediction market panels (PredictIt, Manifold, Kalshi, Polymarket) + Betfair + OddsAPI
- **Kalshi panel**: Reading from `/tmp/kalshi-raw.json` (dedicated agent, fresh every 5min)
- **Polymarket panel**: Reading from `/tmp/polymarket-raw.json` (dedicated agent, fresh every 5min)
- **AI arbitrage feed**: Sourced from `/tmp/arbitrage-opportunities.json` (master agent, runs every 30min)
- **Auth system**: Removed (login/admin routes deleted, middleware open to all)

---

## What Is NOT Working Yet

1. **agent-orchestrator** stopped — no automatic agent health monitoring or restarts
2. **agent-telegram** stopped — no Telegram alerts for high-confidence opportunities
3. **Legacy AI matchers** (politics/other/crypto) stopped — replaced by `agent-master` but not cleaned up; duplicate pm2 entries exist
4. **agent-ui-updater** stopped — `/tmp/ui-data.json` stale until restarted
5. **DEX prices** (agent11-dex) stopped — no DEX arbitrage data
6. **Sports agent** stopped — odds data will go stale after TTL expires
7. **Weather agent** stopped — weather market data will go stale
8. **proxy-eu** stopped — EU-region proxy not available
9. **`pm2 save` not run** — process list will not survive server reboot

---

## Recommended Next Steps

1. `pm2 restart agent-orchestrator` — re-enable health monitoring
2. `pm2 restart agent-telegram` — re-enable alerts
3. `pm2 save` — persist process list across reboots
4. Clean up duplicate `agent-matcher-other` pm2 entries (ids 5 and 9)
5. Decide whether legacy matcher pipeline (agents 4, 5, 7, 8) is still needed alongside `agent-master`
