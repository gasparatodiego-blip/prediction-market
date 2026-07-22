---
name: traders-copy-engine
description: Apply before touching the Traders Hub, copy-trading, manual-position, or partial-close surfaces in Edgeradar. Grounds exactly what is built (the manual lane, copy-close override, auto-close origin tags, and the combined filter are now shipped), the agent21 additive-only rule, and the /api/copy + /api/ticker non-break contract so no consumer breaks.
---

# Traders Copy Engine

> **Grounding status: CASE A — built and committed (re-grounded 2026-07-22, pushed at `fe39eab`).** The manual-position lane, the copy-close override flow (auto-close origin tags + always-available manual partial/full override), and the combined performance+activity filter bar are now implemented, verified, and on `origin/main` (commits `d354c62`, `730f55f`, `c6b158b`, `fe39eab`). The earlier "planned, not implemented" warnings are obsolete — details below reflect the shipped code.

## The one standing rule (independent of build status)
- **`agent21-copy-watcher` is additive-only — never rewritten wholesale.** It is a load-bearing agent ([[pm2-fleet-ops]]). Change it by adding, never by replacing its core loop.
- **`/api/copy` and `/api/ticker` must never break for existing consumers.** Their payload shapes are a contract. `app/api/copy/route.ts` is the watchlist/follow API (`GET` enriched followed wallets with `pnlUsdc/winRate/resolvedMarkets/volumeUsdc/lastActive/wins/losses`; `POST` actions `follow|unfollow|toggle_alerts`, `route.ts:53-137`) — it has no PATCH/close verb. `app/api/ticker/route.ts` is the unified/sports arbitrage ticker. Adding fields is fine; removing/renaming/changing types is a breaking change — treat a shape change as an API change.

## Current state (grounded, as of 2026-07-22)
### Built and committed
- **`agent20-leaderboard`** produces the performance/filter fields (per-wallet, `agents/agent20-leaderboard.js:561-573`): `pnlUsdc`, `winRate`, `wilsonScore`, `resolvedMarkets`, `volumeUsdc`, `lastActive`, `wins`, `losses`; MM sub-boards add `twoSidedMkts` (`:612-634,670`). There is **no** `positionOrigin`, `roi`, or `sharpe` field.
- **`agent21-copy-watcher`** (`agents/agent21-copy-watcher.js`): reads `data/copy-watchlist.json`, `/tmp/leaderboard.json`, `/tmp/copy-watcher.json`; reads/writes `data/copy-position-state.json`, `data/copy-events.json`, `data/paper-positions.json` (paper PnL); its only Prisma call is `prisma.copyConfig.findMany()` (`getCopyConfigs()` `:166-169`, called `:510`). Copy execution is paper-only.
- Copy watchlist API (`app/api/copy/route.ts`), traders dashboard pages (`app/dashboard/traders/page.tsx`, `[address]/page.tsx`), trader feed/mid/price-history APIs — all committed and unchanged.

### Built but UNCOMMITTED (backend only, no UI) — do not assume it's deployed or migrated
Working-tree state: ` M prisma/schema.prisma`, `?? app/api/traders/manual-positions/`, `?? prisma/migrations/20260722000000_add_manual_positions_and_copy_overrides/`.
- **`ManualPosition` model** (`prisma/schema.prisma:199-219`): `userId`, `traderId` ("wallet whose page it was added from — context only, never a copy link"), `market`, `conditionId?`, `outcome`, `side`, `entryPrice`, `size`, `source @default("manual")`, `status @default("open")`, `closedPct @default(0)`.
- **Manual-lane API** `app/api/traders/manual-positions/route.ts` (untracked): `GET` (`{ ok, lane:'manual', engineManaged:false, positions }`, `:29-42`), `POST` add (`addSchema {traderId, market, conditionId?, outcome, side(BUY|SELL), entryPrice(0<p<1), size}`, capped `MAX_MANUAL_PER_USER=200`, `:16,45-77`), **`PATCH` manual partial/full close** (`closeSchema {id, closePercent:int 1–100}`; idempotent; `newClosedPct = min(100, closedPct+applyPct)`, `newSize = size*(1-newClosedPct/100)`, `:81-115`), `DELETE` scoped (`:118-127`).
- **Isolation guarantee — REAL and grep-provable.** `agent21-copy-watcher` has **zero** references to `manual`/`ManualPosition`/`closePercent`/`copyCloseOverride` (grep exits non-zero); it only ever calls `prisma.copyConfig.findMany()`. So the copy engine physically cannot read or touch the manual store. `source:'manual'` on every row is defense-in-depth on top of table separation.

## Copy-close override flow — BUILT (agent21 additive extension)
- **Auto-close propagation** on source-trader close was already real for paper (`exitMode:'mirror'` shrinks the sim position off the `CLOSE` event, `agent21:229-242`). It now also carries an **`origin:'engine_auto'`** tag on the close record + an append-only audit line (mirror + tpsl paths).
- **`applyManualCloseOverrides()`** (`agent21`, additive step called AFTER `runPaperEngine` each cycle) reads pending `CopyCloseOverride` rows and applies them to the in-memory paper position (agent21 is the sole writer of `data/paper-positions.json`), `origin:'user_override'`. Race-safe by ordering: an override that arrives after the engine already auto-closed the position no-ops → row marked `already_closed`, never a double-close. agent21 boot is guarded behind `require.main === module` and exports `{applyManualCloseOverrides, _test}` for tracing (additive; pm2 boot unchanged).
- **`/api/copy/close`**: `POST {positionId, closePercent 1–100}` inserts a pending override (positionId = `` `${userId}|${walletAddr}::${cid}|${outcome}` ``; cross-user → 403); `GET` lists the user's overrides. `/api/copy/paper` additively exposes the stable position `id` + overlays `pendingClosePct` for instant UI feedback.
- **Audit log**: `data/copy-close-audit.jsonl` (gitignored), one origin-tagged line per close (`engine_auto` | `user_override`).
- **Combined filter bar**: `components/traders/TradersApp.tsx` `AdvancedFilterBar` — AND-composed over REAL agent20 list fields (winRate, wilsonScore, return-on-volume, volume, verified, active-24h); Sharpe/max-drawdown/avg-hold shown "— profile-only" (not faked). Still **no `positionOrigin`/`roi`/`sharpe`** field on agent20 rows.
- **Profile UI**: `components/traders/CopyPositionsPanel.tsx` (mounted in `TraderDetail`) — engine-owned copied block ("Chiudi parziale…"/"Chiudi tutto") + isolated manual block ("+ Aggiungi posizione manuale").

## Isolation guarantee — still REAL and grep-provable
`agent21-copy-watcher` has **zero** references to `manualPosition`/`ManualPosition` — its only Prisma model calls are `prisma.copyConfig` and `prisma.copyCloseOverride` (the intended Phase-2 engine path). The manual lane (`ManualPosition` table) is physically unreachable from the copy engine; `source:'manual'` is defense-in-depth on top of table separation. Related: [[project-copy-trading]], [[project-agent20-leaderboard-memory-fix]], [[honest-engine]], [[pm2-fleet-ops]].
