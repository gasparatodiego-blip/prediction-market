---
name: honest-engine
description: Apply whenever computing, formatting, displaying, or labeling any return, ROI, yield, arbitrage opportunity, capacity, funding rate, basis/carry, sports arb, or liquidity reward number in Edgeradar. Enforces the project's "honest engine" non-negotiables so no inflated, fabricated, or misleading figures ship.
---

# Honest Engine — Non-Negotiables

Edgeradar's core identity is the "honest engine": no inflated numbers, fee-adjusted returns, no fabricated fills. Every number that reaches the UI or an alert must pass these rules.

## Metrics & labeling
- Net $/day is ALWAYS the primary metric. Annualized figures are demoted and labeled "run-rate · not guaranteed".
- Any annualized value above 200%/yr is capped and shown as ">200%/yr · run-rate, not guaranteed".
- Always display executable prices (bid/ask), never midpoints, for anything labeled cashable.
- Unconfirmed legs are labeled Signal or Paper — NEVER Cashable.
- Mid-price-only platforms (Futuur, PredictIt, Manifold) are signal-only, never cashable.
- Zero cashable results are displayed calmly as a valid state, never as an error.
- Never fabricate a number under any circumstances. If a value is missing, show it as missing — do not interpolate or invent.

## Suppression rules
- Opportunities with oneLegUnverified=true or fullyConfirmed=false are suppressed from alerts entirely (not just demoted), and demoted visually on list pages.

## Capacity & slippage discipline
- Capacity is anchored to real order-book depth (e.g. 20bps), NEVER to OI heuristics (which overstate 13–50×). Flag thin books as THIN.
- Slippage uses a full VWAP book-walk model (entry + exit), amortized over 14 days ("the cost is certain, the income isn't").
- Green threshold is 30%, not 50% — conservative by design.

## Invariants (must always hold)
- Executable basis ≤ indicative basis, across all contracts.
- Executable basis = futureBid − spotAsk; indicative uses true book midpoint.

## Before shipping any number
- Proactively flag any "too good to be true" figure BEFORE shipping, not after.
- Never introduce new magic constants or thresholds without explicit approval from Diego.
