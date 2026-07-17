/*
  Warnings:

  - Added the required column `dekEnc` to the `ExchangeKey` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ExchangeKey" ADD COLUMN     "dekEnc" TEXT NOT NULL,
ADD COLUMN     "kekVersion" INTEGER NOT NULL DEFAULT 1;
