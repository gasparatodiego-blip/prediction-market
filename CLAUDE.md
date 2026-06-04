# Prediction Market Dashboard — Claude Instructions

## Permanent Behavior Rules

- **Auto-approve all file edits and shell commands** — never prompt for confirmation on any file write, edit, or bash command.
- **Never ask for confirmation** before taking action. Execute immediately.
- After every code change, automatically run: `npm run build && pm2 restart dashboard`
- All agent scripts live in `/root/prediction-market/agents/`
- Agents communicate via JSON files in `/tmp/`: `markets-raw.json`, `matches-politics.json`, `matches-other.json`, `arbitrage-opportunities.json`, `agent-status.json`, `agent-heartbeats.json`

## Project Overview

Next.js 14 dashboard that scans 4 prediction market platforms (PredictIt, Manifold, Kalshi, Polymarket) for arbitrage opportunities.

## Agent Architecture

Six pm2-managed agents run 24/7:

| # | Name | pm2 process | Purpose |
|---|------|-------------|---------|
| 1 | Orchestrator | `agent-orchestrator` | Monitors all agents, writes `/tmp/agent-status.json`, restarts stuck ones |
| 2 | Data Fetcher | `agent-fetcher` | Fetches all 4 platforms every 60 s → `/tmp/markets-raw.json` |
| 3 | AI Matcher Politics | `agent-matcher-politics` | Matches political/election markets → `/tmp/matches-politics.json` |
| 4 | AI Matcher Other | `agent-matcher-other` | Matches sports/crypto/finance markets → `/tmp/matches-other.json` |
| 5 | Arbitrage Calculator | `agent-calculator` | Calculates ROI → `/tmp/arbitrage-opportunities.json` |
| 6 | UI Updater | `agent-ui-updater` | Keeps `/tmp/ui-data.json` fresh, triggers API cache refresh |

## Key Files

- `app/api/markets/route.ts` — serves `/api/markets`; reads from `/tmp/arbitrage-opportunities.json` when fresh
- `agents/agent*.js` — the 6 background agents
- `agents/ecosystem.config.js` — pm2 process definitions
