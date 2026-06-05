# Prediction Market Arbitrage Scanner — Project Documentation

## SECTION 1 — PROJECT OVERVIEW

**Name:** Prediction Market Arbitrage Scanner
**Goal:** Automatically scan prediction markets, sports books, and crypto exchanges for arbitrage opportunities — then alert and auto-rebalance in real time.
**Live URL:** http://167.233.63.218:3000
**Owner:** Diego Gasparato (gasparatodiego@gmail.com)
**Repository:** https://github.com/gasparatodiego-blip/prediction-market

---

## SECTION 2 — COMPLETE HISTORY

### Day 1 — Foundation
- Built Next.js 14 dashboard with TypeScript + Tailwind CSS
- Integrated 4 prediction market platforms: PredictIt, Manifold, Kalshi, Polymarket
- Arbitrage scanner with ROI calculation and countdown timer to market expiry
- GitHub repository setup with initial CI/CD pipeline

### Day 2 — Agent System
- Deployed 7 AI agents running autonomously 24/7 via PM2
- Semantic matching across all market categories (politics, crypto, sports, finance)
- Android remote access configured via Termius SSH
- Auto-deploy via GitHub Actions on every push to main

### Day 3 — Month 1 Complete
- Login system with 3 tiers: Free / Pro / Admin
- Kelly Criterion position sizing calculator
- Liquidity monitor (flags thin markets)
- Longshot bias detector with historical calibration
- 15 expiry filters (1h, 4h, 12h, 1d, 3d, 7d, 14d, 30d, 60d, 90d, 180d, 365d, custom)
- Telegram bot @Gaspola_bot with real-time opportunity alerts
- SQLite database for trade history and performance tracking
- Sentiment analyzer for market bias detection
- OddsAPI integration: 40+ sports bookmakers
- Betfair Exchange integration (replaced Smarkets)

### Day 4 — Month 2 + 3 Complete (today)
- 6 CEX exchanges with Binance WebSocket real-time prices
- DEX prices: Jupiter, dYdX, Uniswap V3, 1inch
- Perpetual futures: Binance FAPI, Bybit, OKX
- Cash & Carry arbitrage (spot vs perpetual basis)
- Funding rate alerts for 6 coins (BTC, ETH, SOL, BNB, XRP, DOGE)
- Delta-neutral auto-rebalancer (agent14) — switches long/short automatically
- Sports markets tab (NFL, NBA, Soccer, Tennis via OddsAPI)
- Weather markets tab (Kalshi + Open-Meteo integration)
- May 2026 backtesting on real Binance funding rate data

---

## SECTION 3 — ALL PLATFORMS

### Prediction Markets
| Platform | Status | Notes |
|----------|--------|-------|
| PredictIt | Active | US political markets |
| Manifold | Active | Play-money + real-money markets |
| Kalshi | Active | Regulated US exchange |
| Polymarket | Active | Crypto-based prediction market |
| Betfair Exchange | Active | via OddsAPI, largest exchange |
| OddsAPI | Active | 40+ bookmakers, sports |
| Metaculus | Active | Forecasting platform |
| Smarkets | Replaced | Replaced by Betfair |
| Augur | Inactive | Ethereum-based, low liquidity |

### CEX Exchanges
| Exchange | Integration | Notes |
|----------|-------------|-------|
| Binance | WebSocket real-time | Primary feed, 6 coins |
| Coinbase | REST 60s | USD pairs |
| OKX | REST 60s | USDT pairs + perpetuals |
| Bybit | REST 60s | USDT pairs + linear futures |
| Kraken | REST 60s | USD pairs |
| Gate.io | REST 60s | USDT pairs |

### DEX / On-Chain
| Protocol | Chain | Notes |
|----------|-------|-------|
| Jupiter | Solana | Aggregator |
| dYdX | StarkEx/Cosmos | Perpetuals |
| Uniswap V3 | Ethereum | AMM |
| 1inch | Multi-chain | Aggregator |

### Perpetual Futures
| Exchange | Coins | Notes |
|----------|-------|-------|
| Binance FAPI | BTC, ETH, SOL, BNB, XRP, DOGE | Funding rates every 8h |
| Bybit Linear | BTC, ETH, SOL | Mark price + funding |
| OKX Swap | BTC, ETH, SOL | Funding rate feed |

---

## SECTION 4 — ALL AGENTS (14 total)

| # | File | PM2 Name | Purpose |
|---|------|----------|---------|
| 1 | agent1-orchestrator.js | agent-orchestrator | Monitors all agents, restarts stuck ones, writes agent-status.json |
| 2 | agent2-fetcher.js | agent-fetcher | Fetches all 4 prediction platforms every 60s → markets-raw.json |
| 3 | agent3-matcher-politics.js | agent-matcher-politics | AI semantic matching for politics/elections → matches-politics.json |
| 4 | agent4-matcher-other.js | agent-matcher-other | AI semantic matching for sports/crypto/finance → matches-other.json |
| 5 | agent5-calculator.js | agent-calculator | Calculates ROI and flags arbitrage → arbitrage-opportunities.json |
| 6 | agent6-ui-updater.js | agent-ui-updater | Keeps ui-data.json fresh, triggers API cache refresh |
| 7 | agent7-matcher-crypto.js | agent-matcher-3 | Dedicated crypto market matcher |
| 8 | agent8-sentiment.js | agent-sentiment | Sentiment analysis and bias detection |
| 9 | agent9-telegram.js | agent-telegram | Telegram bot alerts for arbitrage opportunities |
| 10 | agent10-binance.js | agent10-binance | WebSocket 6 CEX + 3 perp exchanges, CEX arb, funding rates, Telegram alerts |
| 11 | agent11-dex.js | agent11-dex | DEX price aggregation (Jupiter, dYdX, Uniswap, 1inch) |
| 12 | agent12-sports.js | agent-sports | Sports odds via OddsAPI (NFL, NBA, soccer, tennis) |
| 13 | agent13-weather.js | agent-weather | Weather markets via Kalshi + Open-Meteo |
| 14 | agent14-rebalancer.js | agent14-rebalancer | Delta-neutral auto-rebalancer, Kelly sizing, Telegram rebalance alerts |

**IPC:** All agents communicate via JSON files in `/tmp/`:
`markets-raw.json`, `matches-politics.json`, `matches-other.json`, `arbitrage-opportunities.json`, `agent-status.json`, `agent-heartbeats.json`, `exchange-prices.json`, `rebalancer-output.json`

---

## SECTION 5 — ALL FEATURES

### Arbitrage Types
- Cross-platform prediction market arbitrage (PredictIt vs Kalshi vs Polymarket)
- Cross-bookmaker sports arbitrage (40+ books via OddsAPI)
- CEX price arbitrage (6 exchanges, threshold 0.3%)
- Cash & Carry basis trade (spot vs perpetual premium, threshold 0.3%)
- Funding rate arbitrage (collect positive or negative funding, threshold 0.005%/8h)
- Basis trade (spot vs futures spread)
- Delta-neutral auto-rebalancing (agent14 switches long/short based on rate direction)
- Information lag detection (price moves >3% in 1h before market updates)

### UI / Dashboard
- Free / Pro / Admin tier login (JWT httpOnly cookies)
- Kelly Criterion position sizing (inputs: edge, odds, bankroll)
- Liquidity monitor (flags markets below volume threshold)
- Longshot bias calibration (historical probability vs outcome)
- 15 expiry filters
- Sentiment badges on each opportunity
- Crypto tab: real-time CEX prices, CEX arb, futures, funding rates
- Sports tab: live odds, bookmaker arb
- Weather tab: Kalshi weather contracts + forecasts
- Dual platform links (click to open on both sides of arb)

### Alerts
- Telegram bot @Gaspola_bot: new arbitrage opportunities
- Funding rate alert (any of 6 coins crossing ±0.01%/8h, once per 8h)
- Rebalancer alert (⚖️ when position flip needed, 🎯 when best coin changes)

---

## SECTION 6 — STRATEGIES IMPLEMENTED

### 1. Prediction Market Arbitrage
Buy YES on platform A and NO on platform B for the same event when combined cost < $1.00. Profit = $1.00 − cost. Risk: platforms may settle differently.

### 2. Sports Bookmaker Arbitrage
Same event, back all outcomes across different bookmakers so total implied probability < 100%. Guaranteed profit regardless of result.

### 3. Cash & Carry (Basis Trade)
Buy spot BTC + short BTC perpetual futures when futures trade at premium to spot. Lock in the basis spread as risk-free return. Unwind at expiry/convergence.

### 4. Funding Rate Arbitrage
- **Positive rate** (longs pay shorts): Go long spot + short perp → collect funding
- **Negative rate** (shorts pay longs): Go short spot + long perp → collect funding
- Threshold: ±0.005%/8h (below = fees exceed gains)
- Fee model: 4 trades × 0.02% = 0.08% round-trip

### 5. Delta-Neutral Auto-Rebalancing (agent14)
Kelly-like allocation across BTC/ETH/SOL/XRP/DOGE proportional to |fundingRate|. Rebalances every 8h if: allocation shift ≥1% AND monthly gain ≥ 2× rebalance cost. Runs at 07:55, 15:55, 23:55 UTC.

### 6. Basis Trade
Monitor spot vs futures premium. Enter when premium exceeds 0.3%. Similar to cash & carry but focused on the convergence trade.

### 7. Information Lag Detection
Flag crypto markets where the underlying asset moved >3% in the last hour but prediction market price hasn't updated yet. Early mover advantage.

### 8. Longshot Bias
Historically, low-probability outcomes (< 10%) are overpriced on prediction markets. Systematically fade these. Calibrated against historical resolution data.

---

## SECTION 7 — TECH STACK

### Frontend
- **Framework:** Next.js 14 (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **Real-time:** Polling API routes every 30s

### Backend
- **Runtime:** Node.js 20
- **API:** Next.js API Routes (`app/api/`)
- **Database:** SQLite via `better-sqlite3`
- **Auth:** JWT with httpOnly cookies (`jose` + `bcrypt`)

### Agents
- **Runtime:** Node.js (plain, no framework)
- **Process manager:** PM2
- **IPC:** JSON files in `/tmp/`
- **Real-time:** Binance WebSocket (`ws` package)
- **HTTP:** Native `https` module (no axios)

### Deploy
- **CI/CD:** GitHub Actions (push to main → SSH deploy → npm build → pm2 restart)
- **Server:** PM2 ecosystem with auto-restart on crash
- **Build:** `npm run build` (Next.js production build)

---

## SECTION 8 — SERVER

| Property | Value |
|----------|-------|
| IP | 167.233.63.218 |
| Provider | Hetzner Cloud FSN1 |
| Specs | 4GB RAM / 2 vCPU / 75GB SSD |
| OS | Ubuntu 24.04 LTS |
| Node | v20.x |
| PM2 | Always-on process manager |

### Always-running PM2 processes
- `dashboard` — Next.js frontend on port 3000
- `agent10-binance` — WebSocket + 6 CEX + futures + Telegram alerts
- `agent14-rebalancer` — Delta-neutral rebalancer (runs 3× per day)

### Start manually when needed
All other agents (orchestrator, fetcher, matchers, calculator, ui-updater, sentiment, telegram, dex, sports, weather) — start with `pm2 start agents/ecosystem.config.js`

---

## SECTION 9 — CREDENTIALS

> **Security note:** Rotate all credentials before sharing this file publicly.

| Service | Value |
|---------|-------|
| GitHub repo | https://github.com/gasparatodiego-blip/prediction-market |
| Telegram bot | @Gaspola_bot |
| Telegram token | In `agents/ecosystem.config.js` env |
| Admin login | gasparatodiego@gmail.com / Admin123! |
| OddsAPI key | aff711ab10f3f1fba585e30405329c7c |
| Server SSH | root@167.233.63.218 / Prediction1 |

---

## SECTION 10 — BACKTESTING RESULTS (May 2026, real Binance data)

**Strategy:** Cash & Carry funding rate arbitrage on $5,000 per coin
**Period:** May 1–31, 2026 (93 funding periods, 31 days)

| Coin | Gross Funding | Fees | Net Profit | ROI | Annualized APY |
|------|--------------|------|------------|-----|----------------|
| ETH | +$25.90 | −$4.00 | **+$21.90** | 0.438% | **5.3%** |
| XRP | +$24.83 | −$4.00 | **+$20.83** | 0.417% | **5.0%** |
| BTC | +$21.56 | −$4.00 | **+$17.56** | 0.351% | **4.2%** |
| SOL | +$11.42 | −$4.00 | **+$7.42** | 0.148% | **1.8%** |

**Key observations:**
- BTC hit Binance's +0.01%/8h rate cap repeatedly during the May 9–22 bull run ($94k → $111k)
- SOL had the most negative spikes (−0.0139%/8h), dragging its return down
- ETH had the fewest negative periods (2 days vs SOL's 9)
- Fees ($4.00 = 4 trades × 0.02%) are fixed regardless of hold time

**Current live rebalancer position (June 5, 2026):**
- ETH: −0.0065%/8h → `short_futures_long_spot`, 100% allocation ($5,000)
- Expected: **$29.19/month → 7.01% APY**

---

## SECTION 11 — ROADMAP REMAINING

### Month 4 — Politics & Macro AI
- Deep political analysis with LLM-powered probability estimation
- Macro economics markets (Fed rate, CPI, GDP)
- Election outcome modeling

### Month 5 — Geopolitics + Entertainment + Crypto Deep
- Geopolitical event markets
- Entertainment markets (Oscars, Grammy, sports championships)
- Crypto on-chain signal integration

### Month 6 — Mention Markets + Master System
- Social media mention volume as price signal
- Master arbitrage system combining all 8 strategies
- Portfolio-level risk management

### Month 7 — Market Making
- Active liquidity provision on prediction markets
- Bid-ask spread capture
- Inventory management and hedging

### Month 8 — BTC 5-Minute HFT
- 288 funding windows per day at 5-minute resolution
- Statistical arbitrage on short-term price divergence
- Automated execution pipeline

### Plus (anytime)
- Stripe payments for Pro subscriptions
- Custom domain + HTTPS (Let's Encrypt)
- React Native mobile app
- Multi-user portfolio tracking
- API access tier for programmatic users

---

## SECTION 12 — MONETIZATION

### Tier Structure
| Tier | Price | Features |
|------|-------|---------|
| Free | €0 | 3 opportunities visible, rest blurred |
| Pro | €15/month | All opportunities, Telegram alerts, Kelly sizing, full history |
| Profit Share | 10% of profit | Pay only when you earn, no upfront cost |

### Unit Economics
- Break-even: **4 Pro users** covers all costs (€60/month)
- 1 Pro user alone covers server (€12/month)
- Target: **50 Pro users = €750/month**
- 100 Pro users = €1,500/month (highly profitable)

### Growth levers
- Telegram channel for free teasers
- YouTube/TikTok demo videos
- GitHub visibility (open-source agents, closed dashboard)
- Trading communities on Discord/Reddit

---

## SECTION 13 — COSTS

| Item | Monthly Cost |
|------|-------------|
| Hetzner FSN1 server | €12 |
| Claude API (AI matchers) | ~$40–50 (optimized with caching) |
| OddsAPI | Free tier (500 req/month) |
| Binance API | Free |
| GitHub Actions | Free (public repo) |
| **Total** | **~€55/month** |

**Cost optimization done:**
- Claude agents use prompt caching (90% token reduction)
- Agents only run when needed (not all 24/7)
- Binance WebSocket instead of REST polling (free, real-time)
- SQLite instead of hosted DB ($0 vs $20+/month)

---

*Last updated: 2026-06-05*
*Generated by Claude Code*
