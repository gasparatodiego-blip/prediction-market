---
name: traders-copy-engine
description: Apply before touching the Traders Hub, copy-trading, manual-position, or partial-close surfaces in Edgeradar. Grounds exactly what is built vs planned as of this writing (CASE B — partially built, mostly uncommitted), the agent21 additive-only rule, and the /api/copy + /api/ticker non-break contract so no consumer breaks and no planned feature is treated as shipped.
---

# Traders Copy Engine

> **⚠️ Grounding status: CASE B — partial build, mostly uncommitted. Needs a follow-up grounding pass once the Traders Hub work lands and is committed.** As of this writing (grounded 2026-07-22) the manual-position lane exists on disk but is **untracked/uncommitted**, and the copy-engine auto-close/override flow is **planned, not yet implemented** — a schema comment describes behavior no code performs. Re-ground this skill before relying on any "planned" item; do not upgrade a "planned" line to "built" without a fresh grep.

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

## Planned, NOT yet implemented — do not describe as if it exists
- **Auto-close propagation on source-trader close (copy engine): NOT implemented.** The `CopyCloseOverride` model exists in the (uncommitted) schema (`prisma/schema.prisma:228-244`: `positionId`, `walletAddr`, `cid`, `outcome`, `closePercent:int 1–100`, `status @default("pending")`, `origin @default("user_override")`), and its schema comment (`:222-227`) *describes* an API inserting pending rows and agent21 applying them each cycle with an audit `origin`. **No code performs this.** `CopyCloseOverride` is referenced only by its own model definition — no route inserts it, agent21 never reads it. The described flow is aspirational documentation.
- **Copy-engine partial-close override** (`{positionId, closePercent}` against a *copied* position): NOT implemented. The only working partial-close is the manual lane's own PATCH; there is no `/api/copy/close`.
- **Audit log `engine_auto` vs `user_override`: NOT implemented.** `engine_auto` appears nowhere in the repo; `user_override` exists only as the `CopyCloseOverride.origin` default (schema/DDL), never written or read at runtime.
- **`positionOrigin` field: does not exist anywhere.**
- **Combined performance+activity filter redesign: NOT found.** agent20's filter fields are unchanged from prior commits.
- **Frontend wiring for the manual/partial-close lane: ABSENT.** No page or component calls `app/api/traders/manual-positions/route.ts`; the traders pages contain no manual-lane/partial-close/override references.

## When the Traders Hub work lands (follow-up grounding checklist)
Once the above is committed and wired, re-ground and document as CASE A: the real storage separation (table/file names), the real copy-engine partial-close endpoint + payload, the real audit-log format (`engine_auto` vs `user_override`), the real combined-filter field names from agent20, and re-verify the agent21↔manual-store isolation grep still holds. Until then, keep the "planned" items labeled as planned. Related: [[project-copy-trading]], [[project-agent20-leaderboard-memory-fix]], [[honest-engine]].
