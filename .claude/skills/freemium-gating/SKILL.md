---
name: freemium-gating
description: Apply whenever an API route serves a value that differs between free and paid users in Edgeradar, or when deciding whether a new field is gated. Encodes the single server-side gating module, the derived-edge-vs-reference-price split, and the null-not-teaser redaction contract so no fabricated teaser number ever reaches a free client.
---

# Freemium Gating

There is exactly one server-side gating layer: **`lib/paid-gating.ts`** (`getIsPaid`, `redactForTier`, `REDACTION_MAP`). Every route that serves tier-differentiated data calls it. Do not build a second gating path, and never redact in the client — the client only ever receives already-redacted JSON.

## What is gated vs public — derived edge vs reference price
The rule the module encodes: **raw reference data a free user could read from any exchange stays public (teaser); only the DERIVED edge is gated.** Everything NOT listed in `REDACTION_MAP` stays visible (`lib/paid-gating.ts:123-127` — "Everything NOT listed here stays visible … titles, platform names, dates, tier chips, volume, URLs, counts").

- Gated derived-edge fields live in `REDACTION_MAP: Record<RouteKey, string[]>` (`lib/paid-gating.ts:128`), keyed by the `RouteKey` union (`:12-40`). Examples: `valid[].roi`, `valid[].spread`, `valid[].capacityUsd` (prediction, `:140-144`); `spreads[].grossApy`, `spreads[].netApy30d`, `spreads[].capacityUsd`, `spreads[].totalFeesPct` (crypto, `:158-164`); `basisCards[].netUsdPerDay`, `basisCards[].annualizedPct`, `basisCards[].capacityUsd`, `basisCards[].feeUsd` (carry, `:202-205`); `positions[].pnl`, `summary.realizedPnl`, `equityCurve`, `categoryPnl` (trader-feed, `:485-498`).
- Public teaser (explicitly NOT gated): raw per-exchange funding rates / mark / spot prices (crypto, `:155-157`), raw spot/future/bid/ask quotes (carry, `:210-211`), raw venue book prices (sport-arb, `:663-665`).
- **Risk disclosures stay public by design even when adjacent to edge** — `quoteRiskTier`, `quoteRiskFlagged`, `capacitySource`, `feeVerified`, etc. are "RISK DISCLOSURES and venue facts, not edge — a free user must still see that the recommended route buys a synthetic dollar" (`:230-233`). When adding a field, classify it: derived edge → gate it; reference price or risk disclosure → leave it public.

## Redaction nulls the field — it never fabricates
`redactForTier<T>(payload, routeKey, isPaid)` (`lib/paid-gating.ts:677-686`): paid → returns payload untouched; free → deep-clones (`JSON.parse(JSON.stringify(...))`) and nulls every mapped path. The only redaction write in the module sets the leaf to literal `null` (`redactPath`, `:111-114` — `record[seg.key] = null; // leaf — redact`), never `undefined`, never a substituted number. A path with no leaf segment (e.g. `'equityCurve'`, `'history'`, `'recentAlerts'`) nulls the whole feed.

This is the honest-engine rule applied to gating, stated in the file header (`:1-4`): "redaction means setting a real field to null. Never substitute a rounded/teaser/fabricated number for a free user." Do not add a "teaser value" (a rounded/blurred number) server-side — the free client must receive `null` and render the paywall itself. See [[honest-engine]].

## How a route decides free vs paid
`getIsPaid(session)` (`lib/paid-gating.ts:50-60`) reads the Prisma `User` row's `plan` + `planExpiresAt`; no session / no `userId` → `false`. Paid = `isPlanCurrentlyPaid` (`:42-48`): plan `'profit_share'` → always paid; plan `'pro'` → paid only if `planExpiresAt` is in the future (or null); anything else, including an **expired `'pro'`, is free** (`:6-7`). `plan` is a plain `String` (no enum), default `"free"` (`prisma/schema.prisma:19-20`); the vocabulary is `'free' | 'pro' | 'profit_share'` (`lib/plans.ts:1-5`).

Session comes from NextAuth. The standard route shape:
```ts
const session = await getServerSession(authOptions); // authOptions from @/lib/auth
const isPaid  = await getIsPaid(session);
// ... build full payload ...
return NextResponse.json(redactForTier(payload, '<routeKey>', isPaid));
```
Real examples: `app/api/prediction/route.ts:120-121` (redacts at `:334`), `app/api/carry/route.ts:38-39` (redacts at `:270`), `app/api/leaderboard/route.ts:18-20`.

## Wiring a new gated route — checklist
1. Add a `RouteKey` to the union (`lib/paid-gating.ts:12-40`) and an entry in `REDACTION_MAP` listing only derived-edge JSON paths (leave reference/risk fields out).
2. In the route: `getServerSession(authOptions)` → `getIsPaid(session)` → `redactForTier(payload, key, isPaid)` as the last step before responding.
3. An entitlement-only gate (no payload to redact) imports just `getIsPaid` — the one such case is `app/api/copy/config/route.ts:6`.
4. Keep `scripts/paid-gating-selfcheck.ts` green.

## Frontend rendering is out of scope here
How a nulled field renders (blur + Lock + upgrade CTA, or the honest "—" placeholder for a paid user whose value is genuinely null) is owned by the `Redacted` component and `lib/fmt-safe.ts` — see [[frontend-design-system]]. This skill covers only the server-side decision and null contract; don't duplicate the rendering rules.
