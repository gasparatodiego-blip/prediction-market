-- CreateTable
CREATE TABLE "ExchangeKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "apiSecretEnc" TEXT NOT NULL,
    "passphraseEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ExchangeKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExchangeKey_userId_idx" ON "ExchangeKey"("userId");

-- AddForeignKey
ALTER TABLE "ExchangeKey" ADD CONSTRAINT "ExchangeKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
