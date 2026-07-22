---
name: pm2-fleet-ops
description: Apply before restarting, stopping, editing, or reasoning about any pm2-managed agent or the dashboard in Edgeradar. Encodes the real fleet, restart discipline, and which agents are load-bearing for live API surfaces so a routine restart never turns into an outage or a silent data gap.
---

# PM2 Fleet Ops

Ground every action against **live `pm2 list`**, never against memory or the (stale) six-agent table in `CLAUDE.md`. The real fleet is ~35 app processes + `dashboard` + the `pm2-logrotate` module. Process→script mapping lives in `agents/ecosystem.config.js`.

## Restart discipline
- **Restart by exact pm2 process name only:** `pm2 restart <name>`. Names are exact (`agent24-liquidity-rewards`, `agent34-clob-ws`, `dashboard`, …).
- **NEVER `pkill`** an agent — pm2 will fight you (respawn) and you lose the managed state.
- **NEVER `pm2 delete`** (or `pm2 stop`) a process without an explicit human instruction in that same session. Deleting drops it from the fleet until someone re-adds it.
- `pm2 restart`/`reload`, like any deploy action, is **not** auto-approved on an auto-resume turn (see `CLAUDE.md` auto-resume guardrail) — only on a live, attended turn.

## Load-bearing agents — additive-only, never a core rewrite (unless explicitly scoped)
Any agent whose output feeds a live `/api/*` route (writes a `/tmp/*.json` that a route reads) is load-bearing: a broken write shows up as a dead or stale dashboard surface. Change these **additively** — never rewrite the core write path without explicit scope. Verified writer→file→route chains:
- `agent2-fetcher` / `agent-data-collector` → `/tmp/polymarket-raw.json`, `/tmp/kalshi-raw.json` → `/api/markets`, `/api/poly-markets`, `/api/lp`
- `agent5-calculator` → `/tmp/arbitrage-opportunities.json` → `/api/opportunities`, `/api/prediction`, `/api/ticker`, `/api/stats`
- `agent24-liquidity-rewards` + `agent25-kalshi-rewards` → `/tmp/liquidity-rewards.json` → `/api/rewards-unified`, `/api/paper-book`
- `agent34-clob-ws` → `/tmp/clob-live-books.json` → `/api/liquidity-rewards/book`
- `agent27-news-guard` → `/tmp/news-guard.json` → `/api/rewards-unified`
- `agent19-basis` → `/tmp/basis-opportunities.json` → `/api/carry`, `/api/ticker`, `/api/opps-preview`
- `agent20-leaderboard` → `/tmp/leaderboard.json` → `/api/leaderboard`, `/api/copy`, `/api/ticker`
- `agent31-trader-auditor` → `/tmp/trader-feed.json` → `/api/traders/feed/[address]`
- `agent23-prediction-repricer` → `/tmp/repriced-opportunities.json` → `/api/prediction`, `/api/ticker`
- `agent18-mm-analyzer` → `/tmp/mm-analysis.json` → `/api/mm`; `agent17-poly-whales` → `/tmp/poly-whales.json` → `/api/poly-whales`
- `matcher-v2.js` → `/tmp/sports-odds.json` → `/api/sports`

(The `/tmp` IPC contract is the API boundary — a schema/shape change to one of these files is an API change; treat it as such.)

## Restart-count reality (observed `pm2 list`, cumulative over long uptimes — record numbers, don't editorialize)
- **All app processes report `status: online`, `unstable_restarts: 0`.** The only nonzero unstable count is `pm2-logrotate` (module, `unstable=1`).
- High cumulative `↺` counts on long-lived processes are expected churn, not a live fault, and each has a known memory story (see project memories) — e.g. observed at last read: `agent30-trader-feed` 705, `dashboard` 301, `agent2-fetcher` 220, `agent20-leaderboard` 164, `agent31-trader-auditor` 71, `agent5-calculator` 33. State these as observed facts with the actual number and uptime; do **not** infer a crash loop from a high lifetime counter alone.
- `agent20-leaderboard` and `agent30-trader-feed` are memory-sensitive by design (documented profiles) — don't "fix" their restart counts by rewriting streamed writers.

## Standard verification (before considering any pm2-touching change complete)
- Check `pm2` status/restart counter **twice, ~5 seconds apart**. `online` once is not enough — the **restart counter must be stable, not climbing** (a crash loop reads as "online" between respawns).
- For a dashboard/API-affecting change, also confirm the downstream `/api/*` route still returns real data (not just 200) — see [[verification-standard]].
