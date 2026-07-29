-- Per-leg maker controls (agent35-maker): independently enable/disable each leg and set its order size.
--
-- WHY THIS MIGRATION EXISTS AT ALL. These two columns were already present in prisma/schema.prisma and
-- already present in the production database — but NO migration recorded them, so the two histories had
-- silently forked. `prisma migrate status` did not catch it (it only compares applied migration NAMES
-- against the folder, never the actual columns), and the cost of the fork was concrete: agent35-maker
-- logged "The column `RewardsLeg.sizeShares` does not exist in the current database" on every cycle and
-- idled, because `prisma.rewardsLeg.findMany()` selects every field in the schema. Any environment built
-- from migrations alone — a fresh deploy, a restored backup, CI — would have reproduced exactly that.
-- Verified with `prisma migrate diff --from-migrations --to-schema-datamodel` (against a throwaway shadow
-- database): these two columns are the ONLY divergence between the folder and the schema.
--
-- ADDITIVE AND SAFE, both columns:
--   • enabled    NOT NULL but carries a DEFAULT, so every existing row is backfilled to true — the prior
--                behaviour, where a leg that existed was a leg that got quoted. On PostgreSQL 11+ a
--                defaulted column is a catalogue-only change: no table rewrite, no long lock.
--   • sizeShares nullable by design — NULL means "use the engine default" (MAKER_DEFAULT_SIZE), so an
--                existing row keeps behaving exactly as it did before this column existed.
-- Nothing is dropped, renamed, retyped or backfilled with a computed value. No row is deleted.
--
-- IF NOT EXISTS is deliberate: the production database ALREADY has both columns (applied out-of-band),
-- so this migration must be a no-op there while still creating them on every environment that lacks them.
-- That makes it safe to run in either direction and safe to re-run.

ALTER TABLE "RewardsLeg" ADD COLUMN IF NOT EXISTS "enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "RewardsLeg" ADD COLUMN IF NOT EXISTS "sizeShares" DOUBLE PRECISION;
