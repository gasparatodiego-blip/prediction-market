-- Per-market maximum inventory the maker may hold, in dollars of outcome-token notional.
-- DEFAULT 0 is load-bearing: 0 means the bot does NOT re-quote the opposite side after a fill.
ALTER TABLE "RewardsPlacement" ADD COLUMN "maxInventoryUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
