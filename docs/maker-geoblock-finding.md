# Polymarket maker — geoblock diagnosis (2026-07-26)

**Verdict: the order-placement block is IP-DERIVED, not account-derived.**

MAKER-PROVIDERS-ARM proved the whole maker wire works (credentials, signing identity, funding,
approvals, gates) — a live authenticated read succeeds — but `POST /order` is rejected with
HTTP 403 *"Trading restricted in your region"*. This document records why that block is a
property of the **request IP**, established read-only, with no order placed and no proxy used.

## The decisive evidence — the venue's own unauthenticated geoblock oracle

`GET https://polymarket.com/api/geoblock` takes **no account, no credentials, no parameters** —
its answer is purely a function of the requesting IP. From this server's direct egress it returns:

```json
{"blocked":true,"ip":"2a01:4f8:c015:aa8e::1","country":"DE","region":"SN"}
```

The IP alone is reported `blocked:true`. Because the request carries no account context, this is
IP-derived blocking by construction. The detected country **DE** (Germany), region **SN** (Saxony),
matches this server's Hetzner egress (`167.233.63.218`, Falkenstein, Saxony).

## Corroborating evidence

1. **Primary docs** — `https://docs.polymarket.com/developers/CLOB/geoblock`. Blocking is described
   as based on *"the geographic eligibility of the requesting IP address"*; the geoblock endpoint
   reports the *detected IP address*. **DE and IT** are both listed under *"Regulatory-Restricted
   Jurisdictions (Close-Only on Frontend and API)"*, defined as *"Users can close existing positions
   but cannot open new ones, on both the frontend and the API."* That is exactly the observed
   behaviour: authenticated **reads** (getOpenOrders) succeed, **new-order placement** is rejected.

2. **The captured 403** (from `data/polymarket-maker-audit.jsonl`, no new order issued to obtain it):
   ```json
   {"orderId":null,"status":403,
    "error":"Trading restricted in your region, please refer to available regions - https://docs.polymarket.com/developers/CLOB/geoblock"}
   ```
   The adapter recorded only body + status; **no response headers were captured**, and none were
   fetched fresh (that would require a new placement, which is forbidden). The body names the region,
   not the account.

3. **The account exposes no region/restriction flag.** `GET polymarket.com/api/profile/userData` for
   both the signer and the proxy returns only `{id, createdAt, proxyWallet, displayUsernamePublic,
   pseudonym, name, users, verifiedBadge, takerTier, takerTierName}` — **no** region / country /
   jurisdiction / block / restriction field. The public Data API exposes no account region either.
   There is no account-attached restriction to point to; the check happens at request time, by IP.

## What it means for the execution lane

- The block is **tied to the egress IP**, currently a German (DE/Saxony) address, which Polymarket
  restricts to close-only on the API. It is **not** a permanent property of the account: the same
  account, from an IP in a Polymarket-permitted region, would not hit this geoblock.
- **Honest boundary:** this proves the block we hit is IP-derived. It does **not** positively rule out
  an *additional* account-level restriction — that could only be tested by placing an order from a
  non-blocked IP, which is deliberately out of scope (no proxy, no order). But the IP block alone
  fully explains the 403.
- **Compliance note (not just infra):** the operator's own jurisdiction (Italy, IT) is *also* on the
  restricted list. So this is not merely "use a different IP" — a lawful path requires genuinely being
  in, and trading from, a permitted region. Routing around the block was not built, tested, or prepared.

## Constraints honoured

No order was placed (open orders: 0; dollars spent: $0.00). No proxy or alternate egress was used
(direct Hetzner DE egress; no proxy env vars). agent35-maker stayed disarmed throughout
(`MAKER_MODE=off`, `canWrite=false`). No private key or secret was printed. See
`project-maker-geoblock` (session memory) and MAKER-PROVIDERS-ARM (commits 21120aa, beb8ff4).
