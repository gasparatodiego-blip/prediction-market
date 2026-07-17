# Verifying a venue adapter against the live exchange

Every venue in `lib/venues/registry.ts` is `liveVerified: false`. **No live key has ever
been run against any of these adapters.** Until a human runs this procedure and sees it
pass, `POST /api/keys` returns 409 and no key can be stored for that venue.

This file is the procedure. It is deliberately manual: flipping `liveVerified` is a claim
that a person watched a real key behave correctly. There is no UI, no API route, and no
env var that can flip it, and none should ever be added.

---

## Before you start

Create a **NEW** key at the venue:

- **Trade-only. Withdrawals OFF.**
- IP-allowlist it to this server if the venue supports it (Binance `ipRestrict`,
  Bybit `ips`, OKX `ip`).
- **Revoke it at the venue when you are done.** Even a trade-only key is a live credential.

Do not reuse an existing key. Do not paste a key into any file, commit, or chat.

## Which venues can be verified where

| Venue | Guard endpoint | Testnet? |
|---|---|---|
| Binance | `GET /sapi/v1/account/apiRestrictions` → `enableWithdrawals` | **NO — mainnet only.** Binance docs, verbatim: *Q: "Can I use the /sapi endpoints on the Spot Test Network?" A: "No, only the /api endpoints are available on the Spot Test Network"*. There is no testnet path to this endpoint. |
| Bybit | `GET /v5/user/query-api` → `permissions.Wallet` contains `"Withdraw"` | Yes — `api-testnet.bybit.com`. Create the testnet key at testnet.bybit.com **outside Demo Trading mode** (Demo and Testnet are different environments at Bybit). |
| OKX | `GET /api/v5/account/config` → `perm` contains `withdraw` | **Treat as mainnet-only.** Demo trading exists (`x-simulated-trading: 1`) and account/config is not a named exclusion, but the docs do **not** establish whether `perm` is populated in demo. A demo `perm` that came back empty would make a withdraw-enabled key look clean. Do not verify the guard in demo. |
| Bitget | `GET /api/v2/spot/account/info` → `authorities` array contains `"wwow"` (wallet withdrawl) iff the key can withdraw | **Mainnet only.** Needs a real key with a passphrase. A trade-only key's `authorities` will hold trade codes (`stow`/`stor`, `coow`/`cpow`) but NOT `wwow`. Note `wtow`/`wtor` = internal transfer, which is NOT withdrawal — do not conflate. |
| dYdX v4 | On-chain `GET {lcd}/dydxprotocol/accountplus/authenticators/{address}` → the authenticator's `MessageFilter` whitelists only clob order messages | **Mainnet (public chain).** Verified over public REST — no key needed to *read* the chain, but you need a real authenticator to test end-to-end. |
| Paradex | Authenticated `GET /account/keys/subkeys` → the pasted key's derived Stark pubkey must appear with `state: "active"`. Trade-only is STRUCTURAL (a subkey "Cannot Withdraw funds from the account" — docs.paradex.trade/api/general-information/api-authentication), proven by MEMBERSHIP. | **Mainnet only.** ⚠️ **SIGNING IS UNVERIFIED until this runs.** Unlike dYdX (a public read), Paradex's guard needs a StarkNet-signed `POST /auth`. The SNIP-12 auth typed-data in `paradex.ts` is implemented from the SDK shape but has NEVER been run against the venue — until a real subkey authenticates and is accepted here, the signing is unit-tested on parse ONLY. Any signing error fails closed (auth fails → refuse), so it is safe, just non-functional until proven. |
| Gate.io | **none** | **Never verifiable.** No Gate.io endpoint returns the calling key's permissions. `guardVerifiable: false`. Do not flip it. |
| Kraken | **none** | **Never verifiable.** Kraken exposes NO API endpoint that returns a key's permissions (visible only in the web UI). No adapter exists; do not add one. |

## The procedure, per venue

Run from `/root/prediction-market`. Pass creds by env so they never reach shell history
or a file. (Note the leading space — with `HISTCONTROL=ignorespace` it keeps the line out
of history.)

### 1. Trade-only key → must ACCEPT

```bash
 VENUE=bybit API_KEY='...' API_SECRET='...' PASSPHRASE='' node -e '
   const { getVenue } = require("./dist/lib/venues/registry");
   const v = getVenue(process.env.VENUE);
   v.adapter.verifyKey({
     apiKey: process.env.API_KEY,
     secret: process.env.API_SECRET,
     passphrase: process.env.PASSPHRASE || null,
   }).then(r => console.log(JSON.stringify({
     ok: r.ok, canWithdraw: r.canWithdraw, canTrade: r.canTrade,
     permissions: r.permissions, error: r.error,
   }, null, 2)));
 '
```

**Expect:** `ok: true`, `canWithdraw: false`, `canTrade: true`, permissions listed.
If `canWithdraw` is `"unknown"`, **STOP** — the parse does not match what the venue
actually returns. Fix the adapter; do not flip the flag.

### 2. Balance and positions → must READ

Same shape, calling `v.adapter.getBalance(creds)` and `v.adapter.getPositions(creds)`.
**Expect:** real numbers, no error. An empty account is a valid result — an `error` is not.

### 3. Withdrawal-enabled key → must REFUSE (this is the important one)

Temporarily enable withdrawals on the key at the venue, re-run step 1.

**Expect:** `canWithdraw: true`. Then via the API, expect **400** and this body:

> This key has WITHDRAWALS ENABLED, so it was refused and nothing was stored. Create a
> new key with withdrawals disabled (trade-only) and connect that instead.

Then prove it never landed:

```bash
psql "$DATABASE_URL" -c 'SELECT count(*) FROM "ExchangeKey";'
```

**Disable withdrawals again immediately afterwards, then revoke the key.**

### 4. Garbage key → must refuse cleanly

Random strings for key/secret. **Expect:** `ok: false`, `canWithdraw: "unknown"`, a short
error from the fixed vocabulary, **no stack trace**, no row.

### 5. OKX only — wrong passphrase → must be a clear message, not a 500

Correct key/secret, wrong passphrase. **Expect:** `canWithdraw: "unknown"` and
*"OKX rejected this key. Check the API key, the passphrase, the IP allowlist, and the
key's permissions."*

---

## dYdX v4 — how to build a trade-only authenticator to test with

dYdX is not a paste-an-API-key flow. To get a testable trade-only credential:
1. In the dYdX front-end (or via the SDK), create an **authenticator** composed as
   `AllOf(SignatureVerification(traderPubKey), MessageFilter("/dydxprotocol.clob.MsgPlaceOrder,/dydxprotocol.clob.MsgCancelOrder"))`.
   The MessageFilter MUST NOT include any `/dydxprotocol.sending.*` or `/cosmos.bank.*` message.
2. Note the returned **authenticatorId** and your **dydx1… address**.
3. Connect: authenticator private key (as the secret), the address, the authenticatorId, subaccount 0.
4. `verifyKey` will read the authenticator on-chain and confirm the message filter is clob-only. If the
   filter permits any fund-moving message, or the pasted key's pubkey doesn't match the on-chain
   SignatureVerification config, it REFUSES.

## Paradex — D1: prove the StarkNet signing before flipping (it is UNVERIFIED)

Paradex is the first non-HMAC venue and its `POST /auth` StarkNet SNIP-12 signing has NEVER
run against the live venue. Until D1 passes, `verifyKey` is unit-tested on the membership PARSE
only — the signing/auth/list network path is unproven.

1. In Paradex → **Key Management → Subkeys**, create a Subkey; copy its **private key** (shown once)
   and note your **main account address** (`0x…`).
2. Connect: the **Subkey private key** as the secret, the **main account address** as accountAddress.
   Never the wallet key, never the main account key.
3. `verifyKey` must: derive the Stark pubkey → `POST /auth/{pubkey}` (StarkNet-signed) → succeed →
   `GET /account/keys/subkeys` → find the pubkey `state: "active"` → ACCEPT (canWithdraw:false).
   If auth returns no `jwt_token`, the signing (SNIP-12 typed-data, chain id, `/auth/{pubkey}` path,
   `[r,s]` header) is wrong — FIX THE ADAPTER, do not flip the flag. A wrong signature fails closed.
4. Control that the guard fires on membership: connect the **main account key** (not a subkey) — it
   must REFUSE ("not an active subkey"). Connect a **revoked** subkey — it must REFUSE.
5. Confirm `getBalance`/`getPositions` read against `/balance` and `/positions` with the in-memory JWT,
   and that NO JWT is ever written to the DB or disk.

Only when 1–5 pass end-to-end against the live venue may you flip `liveVerified` for paradex.

## The exact line to flip

Only after steps 1–5 pass for that venue. In `lib/venues/registry.ts`, find the venue's
entry and change **one** field:

```diff
   {
     adapter: bybit,
     guardVerifiable: true,
-    liveVerified: false,
+    liveVerified: true,
     mainnetOnly: BYBIT_MAINNET_ONLY,
```

Flip **one venue at a time**, and only the venue you actually tested. Then:

```bash
bash scripts/guarded-build.sh     # serialises builds (rule 67); no restart on failure (rule 68)
```

Commit with what you measured, not what you expect:

```bash
git commit -am "chore(venues): bybit liveVerified — trade-only accepted, withdraw-enabled refused, verified <DATE>"
```

## Never

- Never flip `guardVerifiable` for gate.io. It is a fact about Gate's API, not a TODO.
- Never flip `liveVerified` because the code "looks right" or the unit tests pass. The 20
  fail-closed assertions and the positive control prove the DECISION; they say nothing
  about whether the signing, the base URL, or the live response shape are right.
- Never paste a key into a file, a commit, an issue, or a chat.
- Never leave withdrawals enabled on a key after step 3.
