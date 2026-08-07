# Prediction Market Dashboard — Claude Instructions

## Permanent Behavior Rules

- **Local, reversible work is auto-approved** — file writes, edits, builds, tests, staging, and local commits proceed immediately, without asking.
- **Anything touching real capital always requires explicit confirmation.** This is enforced by permission rules in `.claude/settings.json` (with the same guardrails mirrored at user level in `~/.claude/settings.json`), and it overrides the auto-approve rule above and any "no gates" instruction in a prompt. Never auto-approved: anything touching the Prisma schema or the production DB, any script or endpoint that places real orders, `MANUAL_ORDER_PLACEMENT` / `MAKER_PLACEMENT` / `REALLOC_SCHEDULER_ENABLED`, flipping the bot's AVVIA/FERMA switch from outside the dashboard (writing `data/maker-bot-enabled.json` or `POST /api/maker/bot` — see "The one live switch" below), running `agent35`/`agent40` directly with `node`, editing `.env` or `ecosystem.config.js`, `git push`, `pm2 start/stop/delete/reload/kill`, and destructive file commands (`rm`, `shred`, …).
- **`pm2 restart` is the one exception, and it is deliberate (4 August 2026).** Restarting `agent40-manual-reprice`, `agent41-realloc-scheduler` and `dashboard` is how a green build becomes the running code, it happens several times a session, and it cannot by itself place an order: what would make a restart dangerous is a change to the placement flags or to `ecosystem.config.js`, and **those stay gated**. So `pm2 restart` runs without confirmation; every other pm2 verb still asks.
- After every code change, run `npm run build`. Restarting the affected process afterwards no longer needs a go-ahead — but say which processes were restarted and what the change activates.
- All agent scripts live in `/root/prediction-market/agents/`
- Agents communicate via JSON files in `/tmp/`: `markets-raw.json`, `matches-politics.json`, `matches-other.json`, `arbitrage-opportunities.json`, `agent-status.json`, `agent-heartbeats.json`

### The one live switch: AVVIA/FERMA (7 August 2026)

Whether the bot opens positions on its own is decided in **exactly one place**: `lib/maker/bot-enabled.js`, backed by `data/maker-bot-enabled.json`, toggled by the AVVIA/FERMA button at the top of the dashboard's **Mercati ottimizzati** tab (`data-lrc-tab="alloca"`). `agent41` re-reads it **every cycle**, so FERMA takes effect on the next cycle without a restart. Missing, unreadable, or malformed file ⇒ **stopped**.

`REALLOC_SCHEDULER_DRY_RUN` used to be a second switch for the same decision. It was **removed** on 7 August 2026 — from `ecosystem.config.js` and from every line of `agent41` that read it. Do not reintroduce it, and do not add a fallback env var beside the flag: two switches for one decision mean turning one off doesn't turn the thing off. `REALLOC_SCHEDULER_ENABLED` is **not** a second switch — it decides whether the process does anything at all, not whether it may place orders.

Note the division of labour with the kill switch: FERMA stops *new* placements and rotations while leaving open positions managed (auto-close, repricing, renewals); KILL (`lib/safety/kill-switch`) is separate and absolute.

### Auto-Resume Guardrail: Push/Deploy Requires a Live Human Turn

The "auto-approve" and "no confirmation" rules above authorize autonomous action only for a **live, attended turn** — one kicked off by a fresh human message the user is actually watching. They do not carry over into a turn that resumes on its own, such as via ScheduleWakeup or any other self-scheduled/auto-resume mechanism firing while the user is away.

When the current turn was entered via ScheduleWakeup (or any other auto-resume, not a new human message):

- Local, reversible work stays auto-approved: building, testing, editing/writing files, staging changes, and creating local commits.
- `git push`, and any deploy or process-restart action (including `pm2 restart`, which a live turn may now run freely), are **not** auto-approved — this holds even if the prompt that originally scheduled the wakeup said "no gates" or "do all steps end to end." The `pm2 restart` exception above is scoped to a live, attended turn: an unattended wakeup must not restart a process with nobody watching.
- Instead, complete any remaining local, reversible steps — including cleanup of test artifacts, scratch commits, or temp state — then stop short of `git push` and any deploy/pm2 restart, summarize what's staged/committed and ready to ship, and wait for the next live human message to authorize push/deploy.

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
