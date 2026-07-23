# Polymarket CLOB Maker — isolated placement adapter + staged activation

This is the FIRST component in the project that can **place** orders. It is deliberately isolated from
the cancel-only adapter (`lib/venues/polymarket-clob/`), whose frozen surface and "cannot place" proof
remain untouched (re-asserted in `scripts/maker-selfcheck.js`).

Runs on Diego's own dedicated **test wallet**. Custody risk to third parties is out of scope; operational
safety is not — hence the staged ladder, the isolated adapter, and the rails below.

## The staged activation ladder (`MAKER_MODE`)

| Stage | Venue writes | Key loaded | Scope | How to advance |
|-------|-------------|-----------|-------|----------------|
| `off` (default) | unreachable | no | — | ship default |
| `paper` | none (shadow) | no | all markets w/ legs | `MAKER_MODE=paper` |
| `live-min` | **real** | yes | ONE market (`MAKER_LIVE_MIN_MARKET`), hard per-order cap `MAKER_LIVE_MIN_CAP_USD` (default $25) | `MAKER_MODE=live-min` + wire providers |
| `live` | **real** | yes | normal caps | `MAKER_MODE=live` + wire providers |

Advancing a stage is an **explicit env change by a human**, never automatic. Default on ship is `off`.
**This task arms nothing.**

Two independent belts on top of the mode:
- `MAKER_ADAPTER_DRYRUN=true` — force shadow regardless of mode.
- `MAKER_KILL=true` — halt everything and cancel all resting orders (manual kill switch).

## Key handling — where the signing key lives while armed

- Placement = `createOrder` (L1 EIP-712 signature, **needs the raw private key**) + `postOrder` (L2 HMAC).
  The cancel adapter's address-only signer throws on `_signTypedData`, so it structurally cannot place.
  The maker's `signingSignerFromKey` (this dir) is the only signer that can.
- The raw private key is stored **encrypted** in the existing key-custody envelope as its own
  `ExchangeKey` row (`venue='polymarket-maker'`, `apiSecretEnc` = encrypted key) — the same pattern dYdX
  already uses. No new table/column. Stored by `scripts/polymarket-maker-store-key.ts` (key via env only).
- It is decrypted **only when armed** (`live-min`/`live`), handed straight to the ethers `Wallet`, and the
  reference dropped on `close()`/disarm. **Honest limitation:** a JS string is immutable — we cannot
  memset-zero the key bytes; we minimise their lifetime + references and rely on GC, and never log the
  key, never put it in an error, never write it to the audit trail.
- While armed the key lives **only inside the ethers `Wallet` instance** in the engine process's heap,
  for exactly as long as `MAKER_MODE` is a live stage. `off`/`paper` never call the signer provider.

## ⚠️ CLOB v2 — SDK MIGRATED; the live blocker is now FUNDING + APPROVALS

Polymarket migrated to **CLOB v2 on 2026-04-28** (verified on-chain + docs). The SDK migration is **DONE**
(see the four `feat/chore(polymarket)` commits): the placement path now signs v2. This build is still
**paper-safe and NOT live-ready** — but the blocker is no longer the SDK; it is that nothing is funded or
approved, and the fail-closed gate now says exactly that.

- **SDK (migrated):** the signing path imports **`@polymarket/clob-client-v2`** (installed **1.1.0**).
  The v2 client owns the contracts/collateral/domain internally and resolves the order version from
  `GET /version` (default **2**) → signs **CTFExchangeV2 / NegRiskCtfExchangeV2** with EIP-712 domain
  name `"Polymarket CTF Exchange"`, version **`"2"`**, using the SDK's own v2 order builder (we never
  hand-construct the struct). The old `@polymarket/clob-client@5.8.1` (v1) stays installed **only** for
  the cancel-only adapter + derive-creds; it never touches this placement path.
- **Re-pointed fail-closed gate (`evaluatePlacementGate`, adapter.js):** refuses — before any network
  call or key load, naming the gate — if the v2 SDK is missing/wrong-major, `MAKER_MODE` is not live,
  dry-run is set, **or `MAKER_FUNDING_APPROVED` is not attested** (pUSD funded + ERC-20/ERC-1155 approvals
  granted to the v2 contracts). The funding gate is the honest replacement for the old "v2 SDK absent"
  refusal. Asserted independently in the selfcheck.
- **Contracts (PRIMARY SOURCE — v2 SDK `getContractConfig(137)`):** CTFExchangeV2 `0xE111180000d2663C0091e4f400237545B87B996B`,
  NegRiskCtfExchangeV2 `0xe2222d279d744050d28e00520010520000310F59`. (The SDK also exposes an `exchangeV3`; the
  v2 client only escalates to it if `/version` returns 3 — today it is 2.)
- **Collateral:** **pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`** (6 dec), replacing USDC.e
  `0x2791Bca…`. Onramp USDC/USDC.e → pUSD; approve the **v2** contracts.
- **Order struct (v2, from the SDK's `NewOrderV2`):** drops `feeRateBps` and `nonce`, adds
  `timestamp`/`metadata`/`builder`. It **keeps** `taker` and `expiration` on the wire (correcting the
  earlier note that claimed they were dropped). There is **no fee field** in the v2 order struct.
- **Fees:** **taker-only, protocol-determined at match time; makers pay 0.** Do **not** hardcode a fee or a
  category rate. Read `GET /fee-rate?token_id=<id>` live (`base_fee`, bps) — values are per-market and
  currently inconsistent with the doc tables (one of our own reward tokens returns `base_fee:1000`), so
  trust the live value + the on-chain `fee`/`FeeCharged`, not the docs table. The adapter no longer sends
  `feeRateBps` — it lets the client resolve the authoritative value.
- **Fills:** we read via the CLOB REST/WS API (`listOpenOrders`/`getPositions`), so the redesigned v2
  `OrderFilled` on-chain event does **not** affect us (we never decode on-chain logs).

**Remaining steps before live-min (all Diego's on-chain, signature-gated — OUT OF SCOPE of the SDK migration):**
`npm i @polymarket/clob-client-v2` ✅ done · point the adapter import/constructor/arg-order + re-point the
guard at v2 ✅ done · **fund pUSD** on the wallet ⬜ · **approve** ERC-20 (pUSD→exchange) + ERC-1155 (CTF→the
three exchange contracts) ⬜ · attest via `MAKER_FUNDING_APPROVED` (wire `fundingApproved` into the armed
adapter build) ⬜ · wire the real `makerProviders` in place of the throwing providers ⬜ · then a deep
post-only order you immediately cancel. Until the ⬜ steps are done the funding-approval gate refuses.

## Before the first `live-min` order — wallet prerequisites

A brand-new wallet that only derived L2 API creds **cannot place an order.** Before live-min:
1. Fund the wallet with **pUSD / USDC.e** on Polygon.
2. Set the on-chain approvals: **ERC-20 allowance** (collateral → the exchange) and **ERC-1155 CTF
   approval** to the **three** exchange contracts (CTF Exchange, Neg-Risk CTF Exchange, Neg Risk Adapter).
   Email/Magic proxy wallets get these automatically; a self-custody EOA must set them (approvals script
   or enable trading once via the UI, which initialises the L2 account).
3. Confirm tick + funding with a **deep post-only order** you immediately cancel.

## paper → live-min checklist (step by step)

1. **Stay in paper first.** `MAKER_MODE=paper`. Watch `/tmp/maker-state.json` + `data/polymarket-maker-audit.jsonl`
   for a full session: quotes maintained per channel, re-quotes triggered, out-of-book gap per re-quote,
   rails behaviour. Nothing hits the venue.
2. **Store the signing key** (once): `POLYMARKET_PRIVATE_KEY=0x… POLYMARKET_USER_ID=<id> npx tsx scripts/polymarket-maker-store-key.ts`.
3. **Wire the live provider hook** in `agent35-maker.js` `buildAdapter()` — replace the throwing providers
   with `makerProviders(prisma, userId)` from `credentials.ts`. This is the separate reviewed change; until
   it is done, even `MAKER_MODE=live` cannot obtain a key to sign (fails closed).
4. **Pick the single live-min market**: `MAKER_LIVE_MIN_MARKET=<conditionId>` and confirm
   `MAKER_LIVE_MIN_CAP_USD` (keep it low tens of dollars). Only this market quotes.
5. **Advance**: set `MAKER_MODE=live-min`, restart the engine.
6. **Verify the first real order landed**: `data/polymarket-maker-audit.jsonl` shows a `postOrder`
   `outcome:ok` with an `orderId`; cross-check with `listOpenOrders`.
7. **Stand down fast**: `MAKER_KILL=true` (cancels all) or `MAKER_MODE=off` + restart; or call the
   adapter's `cancelMarketOrders(market)` / `close()`. Effective within seconds.

## Risk rails (all active in every live stage)

Per-market notional cap · total exposure cap · per-market position limit · daily-loss kill switch ·
error-rate breaker · **feed-staleness halt** (never quote off the REST fallback) · market-state halt
(resolved/closed/structurally-degenerate) · **news-high halt** (reuses the news-guard) · manual kill +
cancel-all panic. See `lib/maker/risk-rails.js`; all forced in `scripts/maker-selfcheck.js`.

## Reward mechanics this engine quotes against (measured/flagged)

`S(v,s) = ((v−s)/v)²·b`; two-sided with **c=3** one-sided penalty when mid ∈ [0.10,0.90], mandatory
two-sided in the tails (one-sided earns 0). `v = maxSpread/2` per the project SSOT — **the current docs
phrase v as "max spread from midpoint"; verify empirically before live.** Per-minute random sampling,
epoch-normalised, paid daily 00:00 UTC ($1 min). The **maker-rebate** program is a *separate* revenue
lane (taker-fee funded) not modelled here. Always fetch tick per token (0.1/0.01/0.001/0.0001, +0.0025
for some sports); snap every target to tick before posting.
