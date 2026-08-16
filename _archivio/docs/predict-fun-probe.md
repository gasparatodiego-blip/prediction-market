# Predict.fun Integration Probe — Findings

**Status: SHELVE**
**Probed: 2026-06-23**

---

## Open question (owner action required)

Go/no-go needs mainnet price-divergence vs Polymarket on shared `polymarketConditionIds`. Requires a manually-registered API key — owner action, not automatable here. Steps: connect an EVM wallet at predict.fun, sign the ToS message, obtain a project `x-api-key`, then run a live comparison of Predict.fun YES prices vs the same Polymarket condition IDs to check if typical divergences actually exceed the 2.5% break-even threshold.

---

## Key findings

| Item | Finding |
|------|---------|
| Mainnet read access | Auth-gated — 401 on all endpoints. Requires EVM wallet sign-in + ToS. No cost stated, no email form — just a wallet signature. |
| Testnet access | Open, no key. But data is completely stale: 20 dead markets looping in the paginator, all from Dec 2025. Unusable for market count or depth analysis. |
| Orderbook | Executable CLOB confirmed. `/v1/markets/{id}/orderbook` returns `{asks: [[price, size]], bids: [[price, size]]}` with granular levels. Best bid/ask also embedded inline in the market list response. |
| Fee model | `feeRateBps: 200` — **2.0% flat taker fee on all markets, all sides, no exceptions seen.** Round-trip break-even: ~2.5% gross spread minimum (2% Predict + ~0.5% Polymarket). High bar for liquid political markets where typical spreads are 0.5–3¢. |
| Same-event mapping | `polymarketConditionIds` field present on markets — direct foreign key to Polymarket condition IDs. 19/20 testnet political markets were populated. If mainnet mirrors similarly, same-event detection is trivial, no fuzzy matching needed. |
| Kalshi cross-reference | `kalshiMarketTicker: null` on all tested markets. Kalshi overlap would need fuzzy title matching. |
| Market variants seen | `DEFAULT` (political), `SPORTS_TEAM_MATCH` (EPL), `CRYPTO_UP_DOWN` (BTC/ETH/BNB, multiple intervals). |
| Mainnet market count | Unknown — all count/list endpoints are auth-gated. Cannot estimate without a key. |
| Chain | BNB Chain (BSC). Settlement cannot be hedged against Polymarket (Polygon) or Kalshi (USD custodial). |
| Cross-chain arb type | **Directional / informational only.** Consistent with Phase A honest labeling. No atomic settlement bridge exists. |
| `isYieldBearing` | `false` on all markets tested. |
| `isNegRisk` | `true` on all testnet markets (Polymarket-style neg-risk multi-outcome structure). |

## Why shelved

The 2% flat fee is 4–10× Polymarket's fee. Any arb leg needs >2.5% gross price divergence just to break even before slippage and capital risk. That requires Predict.fun to be systematically mispriced relative to Polymarket — plausible for a smaller BNB-chain audience, but not confirmed. The testnet data is too dead to test this.

The `polymarketConditionIds` mapping is a genuine integration asset — it would make same-event wiring near-trivial on the political slice. That's a reason to revisit, not ignore.

## If pursuing later

1. Owner registers a developer API key (EVM wallet + ToS sign, ~2 min)
2. Run a 1-hour price snapshot: Predict.fun YES prices vs same Polymarket condition IDs
3. If median divergence is consistently >3% on 20+ shared markets → worth building agent
4. If divergence is typically <2% → fee kills it, permanent shelve
