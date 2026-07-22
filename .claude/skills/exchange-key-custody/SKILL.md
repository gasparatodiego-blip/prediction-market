---
name: exchange-key-custody
description: Apply whenever touching exchange API-key storage, encryption, the venue adapters, verifyKey/withdrawal policy, or liveVerified in Edgeradar. Encodes the real envelope-encryption scheme, the per-venue refuse/disclose policy, and the human-only liveVerified gate so no credential is mis-stored and no unverified adapter is trusted.
---

# Exchange Key Custody

Ground against `lib/key-custody.ts`, `lib/venues/registry.ts`, and `scripts/verify-venue-live.md`. Storage only — there is no order/withdraw path built on these keys yet.

## Encryption scheme (as implemented in `lib/key-custody.ts`)
- **Envelope encryption, `aes-256-gcm`** (`ALGORITHM`, `key-custody.ts:42`). Two layers:
  - Per-**row** random 32-byte **DEK** (`newDek()`, `DEK_BYTES=32`) encrypts each credential field (`encryptField`/`decryptField`, fresh 12-byte IV per field).
  - Global **KEK** encrypts only the DEK (`wrapDek`/`unwrapDek`) → stored as `dekEnc` + `kekVersion`. Rotating the master **re-wraps the small DEK only; field ciphertext stays byte-identical** (`rotateRow`, `:250` — and it structurally cannot touch `apiSecretEnc`, which isn't part of `RotatableRow`).
- **KEK registry / versioning:** `KEY_CUSTODY_MASTER` = version 1 (required), `KEY_CUSTODY_MASTER_V<n>` = version n≥2 (`:48-49`, `loadKekRegistry`). `kekVersion` is bound as **GCM AAD** (`wrapDek` `setAAD`, `:141`) so editing the version column without re-wrapping fails closed.
- **Fails closed, no fallback:** if `KEY_CUSTODY_MASTER` is absent or not 32 bytes, the module **throws at import** (`:70-76`) — "There is no fallback by design." A KEK version it doesn't hold → throw, never a guess (`kekFor`, `:100`). Every decrypt failure throws an **identical** message so it can't be used as an oracle (`:216`). `secretsEqual` uses `timingSafeEqual` (`:321`).
- Consequence (matches project memory): a lost `KEY_CUSTODY_MASTER` = unrecoverable rows; rotation = re-wrap every row's DEK. This lives in exactly one module — don't add a master-direct field-encrypt helper (`:21-24` explains why: it would create DEK-less rows rotation skips).

## Per-venue policy — refuse vs accept-and-disclose vs read-only (`scripts/verify-venue-live.md`; `withdrawalPolicy` declared in `registry.ts`)
- **`refuse`** — `verifyKey` reads the venue's permission endpoint and **REFUSES a withdrawal-enabled key** (400, nothing stored): **Binance** (`apiRestrictions.enableWithdrawals`), **Bybit** (`permissions.Wallet` ∌ `Withdraw`), **OKX** (`account/config.perm`), **Bitget** (`authorities` ∌ `wwow`), **dYdX v4** (on-chain authenticator MessageFilter = clob-only), **Paradex** (subkey membership; structurally cannot withdraw). If `canWithdraw` comes back `"unknown"`, the parse is wrong — **fix the adapter, do not flip the flag** (`:61`).
- **`accept_and_disclose`** — nothing here blocks a withdrawal; we only call read endpoints and **DISCLOSE** what the stored credential can do (user acknowledges first): **Gate.io** (no permission endpoint → `withdrawal-permission:UNQUERYABLE`, never `false`), **Kraken** (UNQUERYABLE), **Aster** (records account-level `canWithdraw`, not the key's), **Lighter** (owner-address-locked).
- **`read_only`** — store ONLY read credentials, never the fund-moving L2/zk key: **Extended**, **edgeX**, **ApeX Omni** (`:153`).
- **Permanently unverifiable (facts, not TODOs):** Gate.io `guardVerifiable:false` — "a fact about Gate's API, not a TODO," never flip it (`:189`). Kraken exposes no permission endpoint. `canWithdraw` is tri-state (`true`/`false`/`"unknown"`), fail-closed — never coerce it to a bool.

## `liveVerified:false` is the default and required state
- **Every venue is `liveVerified:false`. No live key has ever been run against any adapter** (`verify-venue-live.md:3`). While false, `POST /api/keys` **409s** and no key can be stored for that venue.
- **No code path may flip it** — no UI, no API route, no env var, and none may ever be added (`:8-9`). It flips **only** when a human runs the manual per-venue procedure and watches a real key behave (trade-only accepted, withdraw-enabled refused, reads work), one venue at a time.
- Passing unit tests / "looks right" is **not** grounds to flip it (`:190`) — the 20 fail-closed assertions prove the decision, not that the signing/base-URL/live-response-shape are correct.

## Deferred-by-decision (document as such, never silently "fix" as bugs)
- **Paradex StarkNet SNIP-12 signing is UNVERIFIED** until the D1 procedure runs against the live venue — unit-tested on parse only; wrong signature fails closed (`:33`, `:111`). Same posture for **Lighter** key-match (Schnorr pubkey derivation unproven, `:150`).
- **JS can't memset-zero a key string** — the maker adapter minimizes lifetime + references and relies on GC (`polymarket-clob-maker/README.md`); rotation does best-effort `dek.fill(0)` (`key-custody.ts:281`). These are stated honest limitations, not open bugs.

## Custody-scope changes are Diego's call
- Adding any venue/flow that requires **holding a private key controlling user funds** is a **product/legal decision reserved for Diego**. Flag it once; do not re-litigate a closed decision. Already-closed: **Polymarket private-key custody is out of scope by Diego's decision** — see [[polymarket-integration]]. The current maker key runs only on Diego's own dedicated test wallet.
