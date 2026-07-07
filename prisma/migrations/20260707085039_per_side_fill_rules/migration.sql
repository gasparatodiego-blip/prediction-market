-- AlterTable
ALTER TABLE "RewardsPlacement" ADD COLUMN     "onFillNo" TEXT NOT NULL DEFAULT 'requote',
ADD COLUMN     "onFillYes" TEXT NOT NULL DEFAULT 'requote';
