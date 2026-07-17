-- AlterTable
ALTER TABLE "ExchangeKey" ADD COLUMN     "permissionsAtVerify" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "verifiedAt" TIMESTAMP(3);
