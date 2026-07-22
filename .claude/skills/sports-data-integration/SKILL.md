---
name: sports-data-integration
description: Apply whenever touching sports odds ingestion, the sports arbitrage classifier, or any sports number/label in Edgeradar. Encodes the real data source and credit budget, the three-tier cashable/arb_soft/signal labeling, the >90s phantom staleness rule, and jurisdiction-as-tag so no stale or mislabeled sports "arb" ships.
---

# Sports Data Integration

Two distinct sports systems exist — keep them straight and ground against the real files.

## System 1 — multi-bookmaker H2H arb (`agents/agent12-sports.js` → `data/sports/opportunities.json`)
- **Vendor: odds-api.net** (Starter plan, **50,000 credits/month HARD CAP**). Auth is the **`X-API-Key` header** (the `?apiKey=` query param returns "Missing credentials"). Key env var: **`ODDS_API_NET_KEY`** in `.env.local`, never hardcoded (`agent12-sports.js:9-11`).
- **Cadence / credit math (measured, not estimated):** one full scan of 10 sports / 115 events = **128 credits** (measured 2026-07-19, `:74`). Cost shape = 1 (/sports) + 1 (/coverage) + 1 per sport list + 1 per eligible event. At **180-min interval** (`SCAN_INTERVAL_MIN`, `:89`) that is 31,744/mo = **63.5% of cap** (120 min → 95.2% was rejected for no headroom). `CREDIT_SAFETY_FLOOR = 2000` reserve, stop before breaching (`:49`). `RATE_LIMIT_MS = 1100` (≥1100ms spacing so a full cycle can't trip the 60 req/min 429, `:70`).

## Three-tier honest labeling (`agent12-sports.js`, the `kind` field)
Real arbs (Σ cost < 1) are split by reliability (`classifyArb`, `:589-626`):
- **`cashable`** — the covering set includes a **sharp leg (Pinnacle, the only `EXEC_SHARP_BOOKS` member)**; high limits, no arb-winner bans (`hasSharpLeg ? 'cashable'`, `:626`).
- **`arb_soft`** — a real arb but **all-soft covering legs** → fragile (limits/bans/line-moves); kept, labeled, never dropped (`:623-626`).
- **`signal`** — everything else: the value/+EV-vs-Pinnacle-no-vig-fair metric; **soft/exchange legs are NEVER cashable** (`cashable:false`, `:568,584,719`).
- **Thresholds:** `ARB_SAFETY_BUFFER = 0.01` → require arbSum < **0.99**, not just <1 (fee/slippage/odds-move headroom, `:65`). `ARB_MAX_PLAUSIBLE_PROFIT = 0.05` → a "guaranteed profit" >5% on a liquid market is a stale/erroneous line → **downgrade to signal** (`:66`). Sharp-edge guards: `SHARP_EDGE_MAX_PLAUSIBLE 0.10`, near-certain excl. `>0.97`/`<0.03` (`:56-58`). `MIN_BOOKMAKERS = 4` to consider an event.

## The >90s phantom staleness rule (`lib/sport-arb-math.js` + `agents/agent33-sport-recorder.js` — the cross-venue system)
- **`MAX_AGE_SEC = 90`** — a leg older than this is **not live → phantom, never an arb** (`sport-arb-math.js:45`). Exists because odds-api stops re-capturing fixed-odds books at kickoff and served 4.3–5.1h-old lines as `is_available:true`; pairing a frozen book against a live leg once manufactured an 18% fake "arb" (`:22-26`).
- **Enforced correctly — verified in code (no open gap):** each row's `is_live` is **derived** as `age < MAX_AGE_SEC` (`agent33-sport-recorder.js:280`); freshly-fetched Kalshi/Polymarket book snapshots are `age_sec:0, is_live:true` by construction (`:352,:432`). `detectArbs` then classifies any crossing with `stale = !(h.is_live && a.is_live)` into the **phantom** stream, never the real/arb stream (`sport-arb-math.js:130,166-172`). Phantoms are written to `data/sport-arb-phantoms.jsonl`, separate from arbs.
- **No `SPORT-FIX`/known-gap marker is present** — a repo grep for `SPORT-FIX|SPORTFIX|SPORT_FIX|known gap` returns nothing open. If you introduce a staleness gap, add such a marker and state it as a known open issue; do not describe it as fixed.
- Related invariants in the same SSOT: max stake = walkable depth on the **thinner** leg only, never OI; missing depth → `sizeUnverifiable`/"—" (`:20,134-141`); never pair different market types (moneyline vs spread/totals/props, `:28,114`).

## Jurisdiction — tag, never a filter (product rule)
- **Product rule, stated in the SSOT:** "Jurisdiction is a TAG, never a filter. Short-lived crossings are KEPT and tagged" (`sport-arb-math.js:27`); `jurisdictionTag` is "descriptive only — callers must never filter on these" (`:87-96`). Rows are never dropped for jurisdiction.
- **Nuance in System 1 (be precise):** `agent12`'s cross-jurisdiction detection feeds the **cashability classifier** — cross-jurisdiction legs make an arb **not cashable → downgraded to `signal`** (a `reasons`/`arbReason` enum, row **KEPT**, `:209,:756,:767,:1025`). That is honest *labeling* of executability, **not** a data filter that removes rows. Don't turn either into a hard row filter.

## Flagged cleanup — deprecated/legacy key path
- **`ODDS_API_KEY`** is a **different, legacy vendor** (the-odds-api.com) and is **no longer read** by the sports scanner — noted at `agent12-sports.js:12`. Flag any remaining reference to `ODDS_API_KEY` / the-odds-api.com as a cleanup item; the live path is `ODDS_API_NET_KEY` (odds-api.net) only.

Every sports number obeys the [[honest-engine]] rules; verify any change end-to-end per [[verification-standard]] (the live `/api/sports` reads `/tmp/sports-odds.json`, written by `matcher-v2.js`).
