-- AlterTable: additive, nullable. No default, no backfill, no data touched.
ALTER TABLE "ExchangeKey" ADD COLUMN "acknowledgedAt" TIMESTAMP(3);
