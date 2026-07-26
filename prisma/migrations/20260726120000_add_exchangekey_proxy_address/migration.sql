-- Polymarket's Magic/email accounts are TWO addresses: the SIGNER EOA (accountAddress, signs only)
-- and the on-chain PROXY/funder wallet that actually holds the pUSD collateral and CTF outcome tokens
-- and is the order `maker`/settlement address. This column persists the proxy alongside the signer so
-- preflight, the settings display and the credential status badge all read one source of truth.
--
-- ADDITIVE and NON-DESTRUCTIVE: nullable, no default value required (NULL = not a Polymarket proxy
-- account, or not yet resolved). No existing row is rewritten; backfill is a separate read-only script.
ALTER TABLE "ExchangeKey" ADD COLUMN "proxyAddress" TEXT;
