---
name: nextjs-data-architecture
description: Apply whenever adding or changing a data-serving path in Edgeradar — a PM2 agent's output file, a shared shaping module, an app/api route, or a dashboard consumer. Encodes the agent→JSON→shared-assemble→route→page pipeline and the "no parallel math" rule so a numbers-diverge bug or a re-implemented calculation never ships.
---

# Next.js Data Architecture

Every live number in Edgeradar flows through the same four-stage pipeline. Respect the stage boundaries — the most common way to introduce a silent divergence bug is to re-shape or re-compute data in a route or component instead of in the one shared module that owns that math.

## The pipeline (four stages)
1. **A PM2 agent writes a JSON file.** Runtime scan outputs go to `/tmp/*.json` (rewritten each cycle); durable/forward state goes to `data/*.json` (atomic write, gitignored). Example: `agent19-basis.js` → `/tmp/basis-opportunities.json`; `agent32-paper-trader.js` → `data/paper-trades.json` (`agents/agent32-paper-trader.js:51`, atomic write at `:811`/`:824`).
2. **A shared `lib/*` module is the single source of truth for shaping that data.** The math/aggregation lives here and nowhere else. Canonical example: `lib/paper-book-assemble.js` — its own header calls it "SINGLE SOURCE OF TRUTH for paper-book aggregation" and lists both consumers (`lib/paper-book-assemble.js:4-11`); entry function `assemblePaperBook(store, opts)` at `:144`, exported at `:289`.
3. **An `app/api/*` route calls that shared module — never re-implements the math.** It reads the JSON file and passes it straight to the shared function. `app/api/paper-book/route.ts:11` imports `assemblePaperBook`, reads the store at `:108` (`STORE_FILE = data/paper-trades.json`, `:34`), and calls `const book = assemblePaperBook(store)` at `:117` under the comment "ONE honest aggregation — the same math agent32's daily report uses."
4. **The dashboard page/component consumes the API route** (client fetch of `/api/*`).

When you touch any stage, ask which stage owns the change. Shaping/derivation belongs in stage 2. A route (stage 3) only wires: read file → call shared module → gate → respond.

## The "no parallel math" rule — the load-bearing invariant
**If two consumers need the same derived number, they MUST call the same shared function. Never re-implement the calculation in the second consumer.** The paper-book case is the enforced proof:
- The agent and the API both call the identical `assemblePaperBook`: `agents/agent32-paper-trader.js:34` (`require('../lib/paper-book-assemble')`) and `:692` (`assemblePaperBook(store, { nowMs: nowMs() })`), vs `app/api/paper-book/route.ts:117`.
- The agent code states the discipline in-line: "ONE aggregation — lib/paper-book-assemble is the SSOT the dashboard also uses, so the Telegram numbers and the page numbers can never diverge … only the SHAPE moved into the shared module. Never changes a number." (`agents/agent32-paper-trader.js:687-692`).
- Even derived flags (THIN "not executable at size") were pulled out of the agent into the shared module so both surfaces read one flag: `agents/agent32-paper-trader.js:683-684`, `THIN_VERDICT` exported from `lib/paper-book-assemble.js:289`.

Related shared-module examples of the same discipline:
- `lib/carry-filter.js` — pure filter/sort/derive shared VERBATIM by the `CashCarryBasis` component and node tests, "so the list the user sees and any measurement of the filter logic can never diverge" (`lib/carry-filter.js:3-8`); consumed at `app/components/CashCarryBasis.tsx:10`.
- `lib/rewards-estimate.js` `estimateReward(...)` — the paper-book route reuses "the exact same call the landing card makes" (`app/api/paper-book/route.ts:9`, called at `:68`).

Ship a `.d.ts` alongside a shared JS module when routes import it from TS (structural only — "the JS module is the source of truth for the math", `lib/paper-book-assemble.d.ts:1-2`).

## The `/tmp` IPC contract is an API boundary
A schema/shape change to a `/tmp/*.json` file that a route reads is an **API change** — see [[pm2-fleet-ops]] for the verified writer→file→route chains. Changing what an agent writes can break a route without touching the route's code.

## data/ — tracked vs gitignored
There is **no blanket `data/` ignore**; each runtime file is ignored by an explicit rule, so an unlisted `data/*.json` stays tracked. Verify against `.gitignore` before assuming — do not guess.
- **Ignored** (runtime-rewritten scan outputs, forward state, personal/secret state, DBs): e.g. `data/liquidity-rewards.json`, `data/kalshi-rewards.json` (`.gitignore:48-50`), `data/copy-events.json`/`data/paper-positions.json` (`:59-61`), `data/paper-trades.json` + `.tmp.*` (`:63-64`), `data/history/` (`:72`), `data/sports/` (`:74`), `data/opportunities.db*` (`:76-78`), `data/polymarket-fee-cache.json` (`:109`).
- **Tracked** (curated backtest/fee reference tables, `git ls-files data/` — 11 files): `basis-hold-to-expiry.json`, `basis-settlements.json`, `carry-optimized.json`, `funding-backtest-all-lanes.json`, `funding-backtest-jul6-19.json`, `funding-fee-optimization.json`, `funding-hold-until-zero.json`, `funding-maker-entry-taker-hedge.json`, `funding-perpspot-realmaker.json`, `venue-fees-official.json`, `venue-maker-fees.json`. (`data/venue-fees-official.json` is the committed fee table the carry route serves.)

Rule of thumb: **runtime output → `/tmp` or gitignored `data/`; curated static reference table → tracked `data/`.** Never commit a rewritten-each-cycle scan file.

## Freemium at the API layer
Routes decide free vs paid response shape at stage 3 via `lib/paid-gating.ts` (`getIsPaid`, `redactForTier`, `REDACTION_MAP`) — e.g. `app/api/carry/route.ts:5,39,270` and `app/api/paper-book/route.ts` (import `:6`, `getIsPaid` `:136`, `redactForTier` `:141`). The same three-symbol import appears across ~10 routes. This module's internals — what's gated and how redaction nulls fields — are owned by [[freemium-gating]]; call it, don't re-implement gating in a route.
