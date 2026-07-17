-- AlterTable
ALTER TABLE "ExchangeKey" ADD COLUMN     "accountAddress" TEXT,
ADD COLUMN     "accountId" TEXT,
ADD COLUMN     "subaccountNumber" INTEGER,
ALTER COLUMN "apiKeyEnc" DROP NOT NULL;
