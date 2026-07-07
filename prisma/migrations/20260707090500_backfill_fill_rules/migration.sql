-- Backward-compat backfill for per-side fill rules. Existing rows carried a single
-- `onFill` rule; map it onto BOTH per-side rules ('flatten' == 'close', else pass
-- through). Idempotent: safe to re-run — sets both sides from the legacy column.
UPDATE "RewardsPlacement"
SET "onFillYes" = CASE WHEN "onFill" = 'flatten' THEN 'close' ELSE "onFill" END,
    "onFillNo"  = CASE WHEN "onFill" = 'flatten' THEN 'close' ELSE "onFill" END
WHERE "onFill" IN ('requote', 'flatten', 'close');
