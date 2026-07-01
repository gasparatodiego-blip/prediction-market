# Prediction Market Dashboard — Claude Instructions

## Permanent Behavior Rules

- **Auto-approve all file edits and shell commands** — never prompt for confirmation on any file write, edit, or bash command.
- **Never ask for confirmation** before taking action. Execute immediately.
- After every code change, automatically run: `npm run build && pm2 restart dashboard`
- All agent scripts live in `/root/prediction-market/agents/`
- Agents communicate via JSON files in `/tmp/`: `markets-raw.json`, `matches-politics.json`, `matches-other.json`, `arbitrage-opportunities.json`, `agent-status.json`, `agent-heartbeats.json`

### Auto-Resume Guardrail: Push/Deploy Requires a Live Human Turn

The "auto-approve" and "no confirmation" rules above authorize autonomous action only for a **live, attended turn** — one kicked off by a fresh human message the user is actually watching. They do not carry over into a turn that resumes on its own, such as via ScheduleWakeup or any other self-scheduled/auto-resume mechanism firing while the user is away.

When the current turn was entered via ScheduleWakeup (or any other auto-resume, not a new human message):

- Local, reversible work stays auto-approved: building, testing, editing/writing files, staging changes, and creating local commits.
- `git push`, and any deploy or process-restart action (including the `pm2 restart dashboard` step above, or any other `pm2 restart`/`pm2 reload`), are **not** auto-approved — this holds even if the prompt that originally scheduled the wakeup said "no gates" or "do all steps end to end."
- Instead, stop after the local build/test/commit steps, write a clear summary of what changed and what's staged/committed and ready to ship, and wait for the next live human message to authorize the push/deploy.

This overrides the "Auto-approve all file edits and shell commands," "Never ask for confirmation," and automatic `pm2 restart` rules above specifically for the push/deploy step, and specifically when the acting turn is an auto-resume rather than me. It does not touch anything else: a normal interactive prompt — including one that says "no gates" — still gets full end-to-end autonomy, push and deploy included.

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
