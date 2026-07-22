---
name: performance-memory-management
description: Apply when diagnosing a suspected memory leak, OOM, or crash-loop in an Edgeradar PM2 agent, or when adding network I/O or an in-memory cache to one. Encodes the real OOM root cause and the wall-clock-deadline fix, the leaderboard cache-eviction pattern, the non-uniform PM2 memory caps, and the diagnostic playbook so a "leak" is confirmed before code is blamed.
---

# Performance & Memory Management

Most "leaks" here are one of three known shapes: a hung socket pinning a half-read response, an unbounded in-memory cache, or a kernel global-OOM SIGKILL that no per-process cap could have prevented. Diagnose which before touching code — the fixes are already in place for the first two, and the third is not a code bug.

## OOM root cause + the wall-clock fix — `lib/httpGet.js`
The historical failure: the old `{ timeout: ms }` + `req.on('timeout')` pattern only fires on **socket inactivity**, so a server that trickles slow keep-alive chunks keeps the socket "active" forever — the request never settles, and the half-read response stays referenced by Node's http machinery. This "stalled agent20 for 6 days" (`lib/httpGet.js:2-6,37`).

The fix is a **hard wall-clock deadline** routed through a single idempotent `settle()` choke point:
- `settle(fn, val)` (`lib/httpGet.js:27-34`) is guarded by a `settled` boolean so exactly one of `end` / req `error` / res `error` / the deadline runs cleanup: `clearTimeout(deadline)`, `req.destroy()`, `res.destroy()`, then resolve/reject. Destroying req/res releases the half-finished response so http machinery stops referencing it — that release is what prevents the pin.
- The deadline (`:51`) is a plain `setTimeout(() => settle(reject, new Error('wall-clock timeout: ...')), timeoutMs)` — independent of per-chunk activity, unlike the old timeout that reset on every chunk. Default `timeoutMs = 15_000` (`:18`).
- `httpPost` uses the identical pattern (`:72,100`).

**When adding any network I/O to an agent, use `lib/httpGet.js` (`httpGet`/`httpPost`) — do not hand-roll `http.request` with `{ timeout }`.** That reintroduces the exact hang this module fixed.

## Bounded in-memory cache — the agent20 eviction pattern
`agents/agent20-leaderboard.js` caps its wallet cache at `MAX_WALLETS_CACHED = 5000` (`:50`; companions `MAX_CIDS_CACHED = 1500` `:49`, `MAX_TITLE_CACHE = 6000` `:69`). `evictWallets()` (`:367-395`) is the model to copy for any unbounded map:
1. No-op if under cap (`:373`).
2. **Protect the live output** — run `buildLeaderboard()` and never evict any wallet currently in the top-N (`categories`/`mmCategories`/`bots`), so eviction can't change today's board (`:375-379`).
3. **Floor-first, then LRU** — among non-protected wallets, evict below-floor (can never rank) first, then least-recently-seen, sorting ascending by `walletLastSeen()` (`:383-387`).
4. Delete exactly `overBy = total - MAX_WALLETS_CACHED` (`:388-393`).

Don't "fix" agent20's or agent30's restart counts by rewriting their streamed writers — those writers are already streamed to halve peak RSS ([[project-agent20-memory-profile]], [[project-agent30-trader-feed]]).

## PM2 memory caps are NOT uniform — read the config
`agents/ecosystem.config.js` sets `max_memory_restart` per agent, and **most agents have none at all** (they inherit pm2's default = no soft cap). Grep before assuming. Observed at last grounding:
- **No cap:** the majority — agent24/25/26, dashboard, agent-data-collector, agent10, agent-master, agent-monitor, agent15/16/17/18/19/21/22, etc.
- **Small caps** (~120–260M): agent28 `120M`, agent14/27/32 `150M`, agent29 `160M`, agent31 `200M`, agent34 `200M`, agent35 `250M`.
- **~500M-class** (each carries the "below OOM-cascade territory" rationale): agent2-fetcher `700M` (`:154`), agent5-calculator `500M` (`:182`), agent30-trader-feed `450M` (`:303`), agent33-sport-recorder `450M` (`:339`).
- **agent20-leaderboard is unique** — the only V8 heap flag `node_args: '--max-old-space-size=1536'` (`:270`) plus `max_memory_restart: '1000M'` (`:271`), heavily documented at `:246-271`. The `1536` is a **backstop, not the operating point** (steady-state RSS ~430MB); the `1000M` pm2 soft cap sits below the V8 backstop to trip a regression early (lowered 1200M→1000M on 2026-07-18, `:260`).

**A lower cap can be a false win:** the Jul-11 deaths were **kernel global-OOM SIGKILLs at 405–615MB RSS, below any ceiling in this range — no pm2 soft cap can pre-empt a global OOM** (`ecosystem.config.js:267-269`). Sizing a cap is about catching a *runaway*, not preventing global OOM.

## Diagnostic playbook for a suspected leak
1. **Restart-count trend first** — `pm2 status` twice, ~5s apart. A *stable* high lifetime `↺` is expected churn, not a live fault; a *climbing* counter is a crash loop. Don't infer a loop from a lifetime total. See [[verification-standard]] and [[pm2-fleet-ops]].
2. **Memory trend** — `pm2 describe <name>` / `pm2 monit`. Is RSS growing unbounded (leak) or oscillating under a self-recycle cap (healthy)?
3. **Rule out known non-leak cost paths before blaming code:**
   - **`matcher-v2.js` is a cron one-shot, not a pm2 process** — runs every 3h via crontab (`~$0.27/mo`, IDF + bounded Haiku confirmation ≤60 pairs, `agents/matcher-v2.js:5,10`), absent from `ecosystem.config.js`, zero resident footprint between runs. Its cost is metered API spend, not memory.
   - **Metered API budgets** (not memory): agent20 `MAX_ENRICH_WALLETS = 200` per scan (`€50/mo` discipline, `:64`); agent33/agent12 share the odds-api.net credit budget ([[sports-data-integration]]).
   - **Kernel global-OOM** — if the death was a SIGKILL at RSS below the agent's cap, it's a whole-box memory event, not that agent's leak. The streaming read/write mitigations in agent20 (`loadCache`/`saveCache`, `:195-200,397-403`) exist precisely because a transient ~370MB stringify/parse on top of the working set global-OOM-killed it.
4. Only after 1–3 point at genuine unbounded growth in the agent's own code, look for an unbounded cache/array and apply the agent20 eviction pattern above.
