# Prediction Market Arbitrage Scanner — Project Documentation

> **Live dashboard:** running on a Hetzner VPS (Falkenstein, EU)  
> **GitHub:** https://github.com/gasparatodiego-blip/prediction-market  
> **Stack:** Next.js 14 · TypeScript · Node.js · SQLite · Claude AI · pm2  
> **Owner:** Diego Gasparato (gasparatodiego@gmail.com)

---

## Table of Contents

1. [Overview](#overview)
2. [Data Sources & Platforms](#data-sources--platforms)
3. [Feature List](#feature-list)
4. [Agent Architecture](#agent-architecture)
5. [Tech Stack](#tech-stack)
6. [Server & Infrastructure](#server--infrastructure)
7. [Telegram Bot](#telegram-bot)
8. [GitHub & CI/CD](#github--cicd)
9. [Roadmap — Months 1–8](#roadmap--months-18)
10. [Monetization Plan](#monetization-plan)
11. [Cost Breakdown](#cost-breakdown)

---

## Overview

The Prediction Market Arbitrage Scanner is a real-time dashboard that monitors **8 prediction market platforms** and **40+ sports bookmakers** simultaneously, using AI to detect arbitrage opportunities — cases where the same real-world event is priced differently across platforms.

**The core insight:** When PredictIt prices "Will X happen?" at 35% and Kalshi prices the same event at 52%, there is a 17-point spread. Buying YES on PredictIt and holding yields a risk-adjusted profit when prices converge, with ROI = (52 - 35) / 35 × 100 = 48.6%.

The system runs a multi-agent pipeline 24/7: fetching live prices, using Claude claude-sonnet-4-6 to semantically match markets across platforms, calculating Kelly-optimal bet sizes, and alerting via Telegram when opportunities appear.

---

## Data Sources & Platforms

### Prediction Markets (8 platforms)

| Platform | Type | URL | What we fetch |
|---|---|---|---|
| **PredictIt** | US regulated exchange | predictit.org | All open markets, contract prices, traded volume |
| **Manifold Markets** | Play-money + real money | manifold.markets | Top 100 by liquidity, binary markets only |
| **Kalshi** | US regulated exchange | kalshi.com | Up to 200 open markets, yes bid/ask prices |
| **Polymarket** | Crypto prediction market | polymarket.com | Active markets, outcome prices, liquidity |
| **Smarkets** | UK exchange | smarkets.com | Live markets, last price / best bid/ask |
| **Metaculus** | Forecasting platform | metaculus.com | Open questions with crowd forecasts |
| **Augur** | Decentralized protocol | augur.net | Open markets via The Graph subgraph (GraphQL) |
| **The Odds API** | Aggregates 40+ bookmakers | the-odds-api.com | EU-region h2h odds in decimal format |

### Sports Bookmakers via The Odds API (40+ books)

The Odds API aggregates live odds from all major European bookmakers. Fetched sports:

- **FIFA World Cup 2026** (72 live events)
- **NFL** (75 events in season)
- **MLB** (15 daily events)
- **NBA** (in season)
- **ATP French Open**

Bookmakers covered include: Betfair Exchange, Pinnacle, William Hill, Unibet, Bet365, Bwin, Betclic, Winamax, LeoVegas, Marathonbet, 1xBet, Matchbook, BetOnline, GTbets, Coolbet, Tipico, Nordicbet, Betsson, and 20+ more.

### Calibration Data Source

- **Manifold Markets resolved markets API** — fetches ~576 resolved binary markets per refresh to build the longshot bias calibration table. Refreshes every 24 hours.

---

## Feature List

### Live Data & Display

- **Real-time market panels** — 8 collapsible panels showing live prices for each platform, with market name, probability, volume, and expiry
- **30-second auto-refresh** — full data refresh every 30 seconds with countdown timer
- **Expiry badges** — colour-coded (red < 1h, amber < 24h, grey otherwise) showing time until each market closes
- **Volume & liquidity** — low-volume warning badge (⚠ LOW LIQ) when market volume < $1,000

### Arbitrage Detection

- **AI-powered cross-platform matching** — Claude claude-sonnet-4-6 semantically matches markets across platforms using meaning, not just keyword overlap. A confidence threshold of ≥ 0.65 is required.
- **Jaccard keyword similarity** — client-side fast matching for real-time display, comparing tokenised question text with a stopword filter
- **Cross-bookmaker sports arbitrage** — for each sports event, detects the bookmaker with the highest vs lowest implied probability for each outcome; 261 events currently show ≥ 3% cross-bookmaker spread
- **Minimum spread threshold** — 3 percentage points required to surface an opportunity
- **ROI cap** — opportunities > 300% ROI are filtered as likely data errors

### Opportunity Ranking & Sizing

- **Kelly Criterion sizing** — calculates the mathematically optimal fraction of bankroll to bet: `edge / odds`, capped at 25% of bankroll
- **Liquidity-aware Kelly** — bet size is capped at the bottleneck liquidity across both sides of the trade
- **Max-bet display** — shows available liquidity per platform per opportunity
- **Earn-per-$100 display** — shows profit for a $100 notional investment
- **Bankroll input** — user can set their bankroll ($1 to any amount); all Kelly calculations update live
- **Max profit calculation** — shows `bottleneck_liquidity × ROI%` for each opportunity

### Staleness & Timing

- **Gap-age tracking** — records the first time each price gap appeared; shows "2h old" / "just now" etc. so stale spreads are visible
- **Gap-age filter** — 15 filter buttons (30m, 1h, 2h, 3h, 6h, 12h, 24h, 2d–30d+) to hide spreads older than a threshold
- **Price staleness file** — `/tmp/arb-prices.json` tracks per-candidate price history across API calls, pruned after 7 days

### Bias Detection

- **Historical calibration** — 576 resolved Manifold markets used to build 12 probability buckets (0–1%, 1–3%, 3–5%, 5–8%, 8–12%, 12–20%, 20–30%, 30–50%, 50–70%, 70–88%, 88–95%, 95–100%) with empirical YES resolution rates
- **Bias score** — `(market_prob − historical_hit_rate) / market_prob` — positive means the market is historically overpriced
- **Coloured bias bar** — visual bar in each arb card: green (well calibrated), yellow (>15% overpriced), red (>30% overpriced)
- **BIAS ALERT badge** — shown on arb cards when bias score > 0.30, displays "BIAS: overpriced X%"
- **Auto-refresh** — calibration data refreshes in background every 24 hours; `POST /api/calibration` triggers manual refresh
- **Accumulated history** — raw resolved markets accumulate in SQLite; calibration improves with each refresh

### Sentiment Analysis

- **Reddit sentiment** — scans r/PredictionMarkets, r/Polymarket, r/Kalshi hot posts every 5 minutes
- **Keyword scoring** — extracts significant words from post titles, scores positive/negative sentiment against 30+ word lists
- **Sentiment badges** — "↑ REDDIT" (green) or "↓ REDDIT" (red) shown on arb cards when a matching keyword is found
- **Top 50 keywords** — ranked by `abs(score) × mentions` across all subreddits

### History

- **SQLite opportunity log** — every arbitrage opportunity found by the pipeline is saved to `data/opportunities.db`
- **History tab** — shows last 100 logged opportunities with date, event name, platforms, spread, and ROI
- **10,000 row cap** — auto-pruned to prevent unbounded DB growth

### UI / UX

- **Dark theme** — deep gray / charcoal colour scheme, Tailwind CSS
- **Platform colour coding** — each platform has a unique accent colour (green = PredictIt, blue = Manifold, yellow = Kalshi, purple = Polymarket, orange = Smarkets, teal = Metaculus, rose = Augur, sky = The Odds API)
- **Demo fallback** — when fewer than 3 real arb opportunities are found and no time filter is active, demo opportunities are shown using real market data with synthetic price offsets
- **DEMO badge** — clearly marks synthetic opportunities so users know they aren't real
- **Beginner explainer** — collapsible "How does this work?" section explaining prediction markets, arbitrage, and Kelly criterion
- **Responsive layout** — grid adapts from 1 to 3 columns depending on viewport width
- **Sticky header** — platform name + live badge + last-update timestamp + refresh countdown always visible

---

## Agent Architecture

Nine agents run under pm2. All communicate via JSON files in `/tmp/`.

### IPC Files

| File | Written by | Read by |
|---|---|---|
| `/tmp/markets-raw.json` | agent-fetcher | agent-matcher-* |
| `/tmp/odds-api-raw.json` | agent-fetcher | agent-calculator |
| `/tmp/matches-politics.json` | agent-matcher-politics | agent-calculator |
| `/tmp/matches-other.json` | agent-matcher-other | agent-calculator |
| `/tmp/matches-crypto.json` | agent-matcher-3 | agent-calculator |
| `/tmp/arbitrage-opportunities.json` | agent-calculator | agent-ui-updater, agent-telegram |
| `/tmp/ui-data.json` | agent-ui-updater | /api/markets route |
| `/tmp/agent-heartbeats.json` | all agents | agent-orchestrator |
| `/tmp/agent-status.json` | agent-orchestrator | (monitoring) |
| `/tmp/sentiment-data.json` | agent-sentiment | /api/sentiment route |
| `/tmp/arb-prices.json` | /api/markets route | /api/markets route |

### Agent Details

#### Agent 1 — Orchestrator (`agent-orchestrator`)
- **Script:** `agents/agent1-orchestrator.js`
- **Interval:** 30 seconds
- **Purpose:** Health monitor for all other agents. Reads heartbeat timestamps from `/tmp/agent-heartbeats.json`. If any agent hasn't written a heartbeat within its timeout window, runs `pm2 restart <agent-name>`.
- **Timeout thresholds:** Fetcher 150s, Matchers 300–350s, Calculator 120s, UI-Updater 90s

#### Agent 2 — Data Fetcher (`agent-fetcher`)
- **Script:** `agents/agent2-fetcher.js`
- **Intervals:** Prediction markets every 60s; The Odds API every 300s (5 min, quota-friendly)
- **Purpose:** Fetches raw market data from PredictIt, Manifold, Kalshi, Polymarket → writes `/tmp/markets-raw.json`. Also fetches from 5 sports via The Odds API → writes `/tmp/odds-api-raw.json`.
- **Error handling:** All fetches have 15s timeout; failures resolve to null and the previous file is kept.

#### Agent 3 — AI Matcher: Politics (`agent-matcher-politics`)
- **Script:** `agents/agent3-matcher-politics.js`
- **Interval:** 90 seconds
- **Purpose:** Filters prediction market data to politics/geopolitics/science/health markets using ~60 keywords. Sends batches of 20 markets to Claude claude-sonnet-4-6 via `claude -p` CLI for semantic pair matching. Writes matched pairs to `/tmp/matches-politics.json`.
- **Categories:** US elections, international elections, government policy, geopolitics (Ukraine, Taiwan, Middle East), science/health (FDA, vaccines, NASA)

#### Agent 4 — AI Matcher: Sports/Tech/Econ (`agent-matcher-other`)
- **Script:** `agents/agent4-matcher-other.js`
- **Interval:** 95 seconds
- **Purpose:** Same as Agent 3 but for sports, technology, and non-crypto economics. Covers NFL, NBA, MLB, Formula 1, Olympics, AI company releases, Federal Reserve decisions, inflation data.

#### Agent 5 — Arbitrage Calculator (`agent-calculator`)
- **Script:** `agents/agent5-calculator.js`
- **Interval:** 45 seconds
- **Purpose:** Reads all three match files. For prediction market pairs: calculates spread, filters < 3% spread, filters > 300% ROI (data error), ranks by ROI. Also reads `/tmp/odds-api-raw.json` and runs direct cross-bookmaker arbitrage calculation (no AI needed — same event, different bookmakers, compare implied probs). Merges both sources (up to 30 total). Writes to `/tmp/arbitrage-opportunities.json` and saves to SQLite DB.
- **Kelly cap:** ROI > 300% is excluded as a data anomaly filter.

#### Agent 6 — UI Updater (`agent-ui-updater`)
- **Script:** `agents/agent6-ui-updater.js`
- **Interval:** 30 seconds
- **Purpose:** Copies fresh arbitrage data to `/tmp/ui-data.json` with a `refreshedAt` timestamp (the API route only reads this file if it's < 120s old). Also pings `GET /api/markets?refresh=1` to warm the Next.js response cache.

#### Agent 7 — AI Matcher: Crypto/Finance (`agent-matcher-3`)
- **Script:** `agents/agent7-matcher-crypto.js`
- **Interval:** 100 seconds
- **Purpose:** Same pattern as Agents 3/4 but specialised for crypto assets (BTC, ETH, SOL, XRP, altcoins), DeFi, NFTs, crypto regulation (SEC, CFTC), and traditional finance (forex, commodities, IPOs, M&A).

#### Agent 8 — Sentiment Analyzer (`agent-sentiment`)
- **Script:** `agents/agent8-sentiment.js`
- **Interval:** 5 minutes
- **Purpose:** Fetches hot posts from r/PredictionMarkets, r/Polymarket, and r/Kalshi via Reddit public JSON API. Extracts keywords from post titles, scores each keyword as positive or negative using word lists, aggregates scores by keyword. Writes top 50 keywords to `/tmp/sentiment-data.json`. The dashboard overlays these scores on arb cards when a keyword matches the market question.

#### Agent 9 — Telegram Alerts (`agent-telegram`)
- **Script:** `agents/agent9-telegram.js`
- **Interval:** 30 seconds
- **Purpose:** Reads `/tmp/arbitrage-opportunities.json`. For each opportunity above `MIN_ROI` (default 1%) that hasn't been alerted yet in this session, sends a formatted Telegram message. Deduplicates using in-memory set (keyed by platform pair + question prefix). Prunes set at 500 entries to prevent memory growth. Skips gracefully if `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` are not set.
- **Message format:** ROI%, buy/sell platforms, probabilities, profit on $100, links to both markets.

### Shared Matcher (`shared-matcher.js`)

All three matcher agents (3, 4, 7) use a shared library that handles:
1. **Market extraction** — parses raw JSON from all 4 prediction market platforms into a normalised `{id, platform, question, probability, url}` format
2. **Keyword filtering** — selects markets whose question text contains category-specific keywords; boosted keywords get extra weight so high-signal markets appear more often
3. **Batch creation** — splits selected markets into batches of 20 for Claude
4. **Claude invocation** — calls `claude -p <prompt> --model claude-sonnet-4-6` via `execFile`. Prompt asks Claude to identify pairs from different platforms that refer to the same real-world event, with confidence ≥ 0.65
5. **Deduplication** — removes duplicate pairs (same two market IDs) across batches

---

## Tech Stack

### Frontend
| Technology | Version | Purpose |
|---|---|---|
| Next.js | 14.2.0 | React framework, App Router, API routes |
| React | 18 | UI components |
| TypeScript | 5 | Type safety across frontend and API |
| Tailwind CSS | 3.4.1 | Utility-first styling |

### Backend / API
| Technology | Version | Purpose |
|---|---|---|
| Next.js App Router | 14.2.0 | Server-side API route handlers |
| better-sqlite3 | 12.10.0 | Synchronous SQLite for opportunity history and calibration |
| Node.js | 20 LTS | Runtime for both Next.js and agent scripts |

### AI
| Technology | Purpose |
|---|---|
| Claude claude-sonnet-4-6 (via Anthropic SDK `^0.100.1`) | Semantic market matching in agent pipeline |
| Claude Code CLI (`claude -p`) | Called by matcher agents as a subprocess |

### Infrastructure
| Technology | Purpose |
|---|---|
| pm2 | Process manager for dashboard and all agents |
| GitHub Actions | CI/CD — auto-deploy on push to main |
| SSH (appleboy/ssh-action) | Deployment trigger |

### Database Schema (`data/opportunities.db`)

```sql
-- Logged arbitrage opportunities (history tab)
CREATE TABLE opportunities (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp    TEXT    NOT NULL,
  event_name   TEXT    NOT NULL,
  platform_low  TEXT   NOT NULL,
  platform_high TEXT   NOT NULL,
  prob_low     REAL    NOT NULL,
  prob_high    REAL    NOT NULL,
  roi          REAL    NOT NULL,
  spread       REAL    NOT NULL
);

-- Raw resolved markets for calibration
CREATE TABLE calibration_markets (
  id           TEXT PRIMARY KEY,  -- e.g. "mf-abc123"
  source       TEXT NOT NULL,     -- "manifold"
  final_prob   REAL NOT NULL,     -- 0–100, pre-resolution probability
  resolved_yes INTEGER NOT NULL,  -- 1 = resolved YES, 0 = resolved NO
  fetched_at   TEXT NOT NULL      -- ISO timestamp
);

-- Aggregated calibration buckets
CREATE TABLE calibration_buckets (
  bucket_key TEXT PRIMARY KEY,    -- e.g. "1-3", "5-8"
  bucket_min REAL NOT NULL,       -- lower bound (inclusive)
  bucket_max REAL NOT NULL,       -- upper bound (exclusive)
  total      INTEGER NOT NULL,    -- total markets in bucket
  yes_count  INTEGER NOT NULL,    -- markets that resolved YES
  hit_rate   REAL NOT NULL,       -- yes_count / total (0–1)
  updated_at TEXT NOT NULL
);
```

---

## Server & Infrastructure

### VPS Specifications

| Property | Value |
|---|---|
| Provider | Hetzner Cloud |
| Location | Falkenstein, Germany (FSN1) |
| Type | ubuntu-4gb-fsn1-1 |
| OS | Ubuntu 24.04 LTS |
| Kernel | 6.8.0-117-generic |
| RAM | 3.7 GB total, ~2.8 GB available |
| Disk | 75 GB SSD, ~5 GB used |
| CPU | 2 vCPUs |
| Arch | x86_64 |

### pm2 Processes

| pm2 ID | Name | Status |
|---|---|---|
| 1 | dashboard | online (Next.js on port 3000) |
| 0 | proxy-eu | stopped (reverse proxy) |
| 2 | agent-orchestrator | stopped (started on demand) |
| 3 | agent-fetcher | stopped |
| 4 | agent-matcher-politics | stopped |
| 5 | agent-matcher-other | stopped |
| 6 | agent-calculator | stopped |
| 7 | agent-ui-updater | stopped |
| 8 | agent-matcher-3 (crypto) | stopped |
| 9 | agent-sentiment | stopped |
| 10 | agent-telegram | stopped |

> **Note:** All agents except `dashboard` are currently stopped. The dashboard self-refreshes by calling live APIs on each `/api/markets` request. Agents can be restarted with `pm2 start agents/ecosystem.config.js`.

### Key Directories

```
/root/prediction-market/
├── agents/              # 9 agent scripts + ecosystem.config.js + shared-matcher.js
├── app/
│   ├── api/
│   │   ├── calibration/ # POST: run calibration; GET: fetch bucket data
│   │   ├── history/     # GET: last 100 logged opportunities
│   │   ├── markets/     # GET: main API — fetches all platforms, returns arb candidates
│   │   └── sentiment/   # GET: returns sentiment-data.json
│   └── page.tsx         # Main dashboard UI
├── data/
│   └── opportunities.db # SQLite: opportunity history + calibration data
├── lib/
│   └── calibration.ts   # Shared calibration logic (computeBiasScore, runCalibration, etc.)
├── public/
└── .github/workflows/   # CI/CD auto-deploy pipeline

/tmp/                    # Agent IPC files (ephemeral, recreated on restart)
├── markets-raw.json
├── odds-api-raw.json
├── matches-politics.json
├── matches-other.json
├── matches-crypto.json
├── arbitrage-opportunities.json
├── ui-data.json
├── agent-heartbeats.json
├── agent-status.json
├── sentiment-data.json
└── arb-prices.json
```

---

## Telegram Bot

The system sends real-time arbitrage alerts via a Telegram bot.

### Setup

1. **Create a bot:** Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → follow prompts → copy the API token
2. **Get your chat ID:** Start your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` — look for `"chat":{"id":NNNNNN}`
3. **Set environment variables** in pm2 ecosystem config or `.env`:
   ```
   TELEGRAM_BOT_TOKEN=<your-bot-token>
   TELEGRAM_CHAT_ID=<your-chat-id>
   MIN_ROI=5          # Only alert on opportunities with ROI ≥ 5%
   INTERVAL=30000     # Check every 30 seconds
   ```

### Alert Format

```
🚨 ARB ALERT
Event: Will X happen by end of 2026?
ROI: 23.4%
Buy PREDICTIT at 38% vs KALSHI at 52%
Invest $100 → earn $23.4
🔗 Links:
• Predictit: https://www.predictit.org/markets/detail/...
• Kalshi: https://kalshi.com/markets/...
```

### Deduplication

Alerts are deduplicated per session using an in-memory Set keyed by `platform_low:platform_high:question_prefix`. This prevents repeat alerts for the same opportunity while it persists. The set is pruned to 500 entries when it grows large. On agent restart, the deduplication state resets (a fresh alert will fire for any still-open opportunity).

---

## GitHub & CI/CD

### Repository

**URL:** https://github.com/gasparatodiego-blip/prediction-market

### Auto-Deploy Pipeline

Every push to `main` triggers automatic deployment via GitHub Actions:

```yaml
# .github/workflows/deploy.yml
on:
  push:
    branches: [main]

steps:
  - SSH into VPS (Hetzner)
  - cd /root/prediction-market
  - git pull origin main
  - npm install --production=false
  - npm run build
  - pm2 restart dashboard
```

Secrets required in GitHub repository settings:
- `DEPLOY_HOST` — VPS IP address
- `DEPLOY_KEY` — SSH private key with root access

### Commit History

| Commit | Description |
|---|---|
| `4579e24` | Add historical calibration-based longshot bias detector |
| `72dff1d` | Replace Betfair with The Odds API for cross-bookmaker arbitrage |
| `f1148f8` | Add expiry filter, max-bet liquidity sizing, and smart Kelly capping |
| `886c8f9` | Complete Month 1 features: 8 platforms, Kelly sizing, sentiment, history DB, Telegram alerts |
| `4eb7272` | Add GitHub Actions auto-deploy workflow |
| `26c75bf` | Add 7-agent pipeline for AI-powered cross-platform arbitrage matching |
| `f29a4fc` | Wire all 4 prediction market platforms to real price data |

---

## Roadmap — Months 1–8

### Month 1 — Foundation ✅ COMPLETE

**Goal:** Working dashboard with real data and core arbitrage detection.

- [x] Next.js 14 dashboard with live data from 4 platforms (PredictIt, Manifold, Kalshi, Polymarket)
- [x] 7-agent pm2 pipeline: fetcher → AI matchers → calculator → UI updater → orchestrator
- [x] Claude claude-sonnet-4-6 semantic matching across platforms (confidence ≥ 0.65)
- [x] Kelly criterion sizing with liquidity awareness
- [x] Reddit sentiment overlay (3 subreddits, keyword scoring)
- [x] SQLite opportunity history + history tab in UI
- [x] Telegram bot alerts with ROI threshold and deduplication
- [x] GitHub Actions auto-deploy on push to main
- [x] 8-platform expansion: added Smarkets, Metaculus, Augur, Betfair → then The Odds API (40+ bookmakers)
- [x] Gap-age staleness tracking + 15-button time filter
- [x] Max-bet liquidity sizing in arb cards
- [x] Historical calibration-based longshot bias detector (12 probability buckets, SQLite-backed)
- [x] Cross-bookmaker sports arbitrage (261 events with ≥ 3% spread detected)

---

### Month 2 — Data Quality & Execution Intelligence

**Goal:** Reduce false positives, add execution feasibility scoring.

- [ ] **Market liquidity depth** — fetch order book depth (not just top-of-book) for PredictIt and Kalshi; show slippage estimates for each bet size
- [ ] **Price impact model** — estimate how much a given bet size moves the market price; adjust effective ROI downward for large positions
- [ ] **Market correlation filter** — detect and suppress arb opportunities that are structurally correlated (e.g., "will X win?" and "will Y lose?" in the same event)
- [ ] **Execution time window** — show estimated hours/days until market closes as primary sort key; prioritise imminent opportunities
- [ ] **Verified resolution data** — cross-reference market resolutions against news APIs to confirm historical calibration accuracy
- [ ] **False positive tracking** — log which "opportunities" were still open at market close, and whether the spread converged; use this to refine the 0.65 confidence threshold
- [ ] **Multi-leg arbitrage** — detect 3-way arb (e.g., home/draw/away in soccer) using the full overround formula across all bookmakers
- [ ] **API rate limit dashboard** — track The Odds API quota usage (requests remaining in response headers); alert when < 100 requests left this month

---

### Month 3 — User Accounts & Personalisation

**Goal:** Multiple users, saved preferences, personal portfolio tracking.

- [ ] **Authentication** — add NextAuth.js with Google + email/password sign-in
- [ ] **User profiles** — store bankroll, risk tolerance (conservative/moderate/aggressive Kelly multiplier), preferred platforms
- [ ] **Watchlist** — let users bookmark specific markets or events; highlight when a watched market shows a new opportunity
- [ ] **Alert customisation** — per-user Telegram chat IDs and ROI thresholds stored in DB; agent-telegram reads per-user config
- [ ] **Portfolio tracker** — log simulated positions (market, platform, amount, entry probability); show P&L as markets resolve
- [ ] **Custom platform weights** — let users disable platforms they don't have accounts on; filter opportunities accordingly
- [ ] **Email digest** — daily or weekly summary email of best opportunities found (using Resend or Postmark)

---

### Month 4 — Monetisation Infrastructure

**Goal:** Begin generating revenue from the platform.

- [ ] **Freemium tier** — free: 2 opportunities shown, blurred, no Kelly sizing; paid: all opportunities, full Kelly, bias scores, history
- [ ] **Stripe integration** — monthly subscription ($29/month) and annual plan ($199/year); webhook for subscription state changes
- [ ] **API access tier** — developers can call `/api/markets` with an API key; rate-limited by plan; billed per 1,000 requests above free tier
- [ ] **Affiliate link injection** — when user clicks "View on Kalshi/PredictIt", route through affiliate link; track clicks and conversions
- [ ] **Referral system** — unique referral codes; 30-day credit for successful referrals
- [ ] **Usage-based billing** — track Telegram alerts sent per user per month; charge overage above free-tier limit (10 alerts/month free, then $0.10/alert)

---

### Month 5 — Advanced Analytics

**Goal:** Make the dashboard the definitive research tool for prediction market traders.

- [ ] **Calibration deep-dive page** — full calibration chart showing all 12 buckets, hit rate vs market probability, R² of calibration; shows how well each platform is calibrated individually
- [ ] **Historical opportunity viewer** — searchable/filterable history of all past opportunities; filter by platform, ROI range, category, date; export to CSV
- [ ] **Market correlation matrix** — show which market categories tend to move together (using historical data); help users diversify their arb portfolio
- [ ] **Platform reliability scores** — track which platforms' prices tend to be the "correct" one when a spread appears and converges; use as a prior in arb ranking
- [ ] **Opportunity lifespan analysis** — for each historical opportunity, how long did the spread persist before closing? Use this to set urgency recommendations
- [ ] **Volume-weighted probability** — weight the "true" probability as a volume-weighted average across platforms instead of simple mid-market; reduces noise from thin books

---

### Month 6 — Scale & Reliability

**Goal:** Production-grade reliability for paying customers.

- [ ] **Monitoring & alerting** — Grafana/Prometheus or Uptime Robot for dashboard uptime; PagerDuty alert if dashboard is down > 2 minutes
- [ ] **Multi-region deployment** — replicate to a US-east VPS; round-robin DNS or Cloudflare load balancing for latency-sensitive users
- [ ] **Agent failure recovery** — if an agent crashes > 3 times in 10 minutes, send admin Telegram alert and pause Telegram user alerts to prevent spam
- [ ] **Data backup** — daily SQLite backup to S3 (or Hetzner Object Storage); keep 30-day retention
- [ ] **Request queuing** — add a Redis queue for Claude API calls so matchers don't starve or overlap under load
- [ ] **Graceful degradation** — if Manifold or PredictIt API is down, mark that platform as unavailable in the UI rather than showing stale data
- [ ] **Rate limit handling** — exponential backoff + retry for all external API calls; log 429/503 responses to Sentry
- [ ] **Test suite** — unit tests for `computeBiasScore`, `calcArb`, `kellyFraction`, `detectArbitrage`; integration test for the full pipeline on fixture data

---

### Month 7 — Mobile & Notifications

**Goal:** Mobile-first experience and push notification system.

- [ ] **Progressive Web App** — add manifest.json + service worker; allow "Add to Home Screen" on iOS and Android
- [ ] **Push notifications** — Web Push API for in-browser alerts (no Telegram required); user opts in per-device
- [ ] **Mobile-optimised layout** — single-column arb cards, swipe to dismiss, bottom navigation bar for Opportunities / History / Settings
- [ ] **Native app (React Native / Expo)** — thin wrapper around the PWA; published to App Store and Google Play
- [ ] **Notification batching** — group multiple alerts into a single push notification when ≥ 5 opportunities appear simultaneously
- [ ] **Sound alerts** — optional chime when a high-ROI (> 20%) opportunity appears during active session

---

### Month 8 — Execution Automation

**Goal:** Semi-automated trade execution for power users.

- [ ] **Kalshi API trading** — integrate Kalshi REST trading API; allow one-click "Buy YES" from the arb card with quantity pre-filled from Kelly calculation
- [ ] **Manifold API trading** — Manifold has a public trading API; execute limit orders automatically when a spread exceeds user's threshold
- [ ] **Trade queue** — user approves each trade before execution (semi-auto), or enables fully-automatic mode with per-trade and per-day dollar caps
- [ ] **Position tracking** — all executed trades logged to DB; P&L tracked as market prices update; realised P&L logged on resolution
- [ ] **Risk management** — hard stop if cumulative daily loss exceeds a user-set limit; automatic pause of all trading
- [ ] **Polymarket CLOB integration** — Polymarket's Central Limit Order Book API supports market and limit orders; integrate for crypto-native users
- [ ] **Audit log** — full audit trail of every automated trade decision (reason, amount, platform, timestamp); downloadable for tax purposes

---

## Monetization Plan

### Revenue Streams

#### 1. SaaS Subscriptions (Primary)

| Tier | Price | Features |
|---|---|---|
| **Free** | $0/month | 2 opportunities (blurred), no Kelly sizing, no bias scores, 7-day history |
| **Pro** | $29/month | All opportunities, full Kelly + liquidity sizing, bias bar, Telegram alerts, 90-day history, CSV export |
| **Team** | $99/month | Up to 5 users, shared watchlist, API access (10k req/month), priority email support |
| **Annual Pro** | $199/year | All Pro features, 2 months free vs monthly |

**Target:** 200 Pro subscribers by end of Month 6 = ~$5,800 MRR

#### 2. API Access (Developer)

Prediction market data aggregated across 8 platforms is valuable for researchers, quants, and other tool builders.

| Plan | Price | Included |
|---|---|---|
| **Starter** | $49/month | 5,000 API calls/month, 2 platforms |
| **Growth** | $149/month | 50,000 calls/month, all 8 platforms, bias scores |
| **Enterprise** | Custom | Unlimited, SLA, dedicated support |

#### 3. Affiliate Commissions

- PredictIt, Kalshi, Polymarket, and Smarkets all have affiliate programs paying 15–30% of first-month fees or per-trade commissions
- Each "View on Platform" link will be an affiliate link
- Estimated: $5–15 per new user referred to a trading platform

#### 4. Sponsored Opportunities

- High-liquidity prediction markets from new platforms can pay for featured placement on the dashboard
- Vetted platform partners only; clearly labelled as sponsored
- Estimated: $500–2,000/month per sponsor at scale

#### 5. Data Licensing

- Sell calibration data and opportunity history to academic researchers, hedge funds, and quant firms
- One-time data dumps or ongoing data feeds
- Estimated: $1,000–10,000 per deal

### Target MRR Milestones

| Month | Subscribers | MRR | Key Driver |
|---|---|---|---|
| 3 | 20 Pro | $580 | Early access launch |
| 4 | 75 Pro | $2,175 | Stripe integration + marketing |
| 5 | 150 Pro | $4,350 | Affiliate links live |
| 6 | 250 Pro + 5 API | $8,000 | API launch |
| 8 | 500 Pro + 20 API + trading | $20,000+ | Execution automation |

---

## Cost Breakdown

### Monthly Running Costs

#### Infrastructure

| Item | Cost/Month | Notes |
|---|---|---|
| Hetzner VPS (CX22) | €3.79 (~$4) | 2 vCPU, 4 GB RAM, 40 GB SSD — current server |
| Hetzner VPS US (future) | €5 (~$6) | Month 6 multi-region |
| Domain name | $1.50 | ~$18/year amortised |
| Cloudflare | $0 | Free tier covers DNS + DDoS |
| **Infrastructure subtotal** | **~$12/month** | |

#### APIs

| Item | Cost/Month | Notes |
|---|---|---|
| The Odds API | $0 | Currently on free tier (500 req/month); paid plans from $79/month at scale |
| Manifold API | $0 | Public, free |
| PredictIt API | $0 | Public, free |
| Kalshi API | $0 | Public, free |
| Polymarket API | $0 | Public, free |
| Smarkets API | $0 | Public, free |
| Metaculus API | $0 | Public, free |
| Reddit API | $0 | Public JSON API, no key required |
| **API subtotal** | **$0–$79/month** | Scales with request volume |

#### AI (Claude API)

The matcher agents call `claude -p` (Claude Code CLI) which uses Claude claude-sonnet-4-6. Cost depends on how many matching batches run per day.

| Scenario | Batches/Day | Tokens/Batch | Cost/Day | Cost/Month |
|---|---|---|---|---|
| Agents stopped (current) | 0 | — | $0 | $0 |
| All 3 matchers running | ~270 | ~2,000 in + ~300 out | ~$0.50 | ~$15 |
| Heavy load (all running, 24/7) | ~864 | ~2,000 in + ~300 out | ~$1.60 | ~$48 |

Claude claude-sonnet-4-6 pricing: $3/M input tokens, $15/M output tokens.

#### Communications

| Item | Cost/Month | Notes |
|---|---|---|
| Telegram Bot API | $0 | Free |
| Email (Resend, future Month 3) | $0–$20 | Free tier: 3,000 emails/month |
| **Communications subtotal** | **$0–$20** | |

#### Business

| Item | Cost/Month | Notes |
|---|---|---|
| GitHub (private repo) | $0 | Free tier |
| Stripe (future Month 4) | 2.9% + $0.30/tx | Only on revenue |
| **Business subtotal** | **$0 + revenue %** | |

### Total Current Monthly Cost

| Category | Cost |
|---|---|
| Infrastructure | ~$12 |
| APIs | $0 |
| AI (agents stopped) | $0 |
| **Total** | **~$12/month** |

### Total at Full Operation (All Agents Running)

| Category | Cost |
|---|---|
| Infrastructure | ~$12 |
| APIs (The Odds API paid tier) | ~$79 |
| AI (3 matchers, 24/7) | ~$48 |
| Email | ~$10 |
| **Total** | **~$150/month** |

**Break-even at full operation:** 6 Pro subscribers ($29 × 6 = $174/month).  
**Margin at 200 Pro subscribers:** $5,800 - $150 = **$5,650/month (~97% margin)**.

---

*Last updated: 2026-06-05*  
*Maintained by: Diego Gasparato — gasparatodiego@gmail.com*
