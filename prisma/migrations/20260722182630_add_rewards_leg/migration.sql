-- CreateTable
CREATE TABLE "RewardsLeg" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "book" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'follow',
    "offsetC" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "onFill" TEXT NOT NULL DEFAULT 'requote',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardsLeg_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RewardsLeg_userId_marketId_idx" ON "RewardsLeg"("userId", "marketId");

-- CreateIndex
CREATE INDEX "RewardsLeg_marketId_idx" ON "RewardsLeg"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardsLeg_userId_marketId_book_kind_price_key" ON "RewardsLeg"("userId", "marketId", "book", "kind", "price");

-- AddForeignKey
ALTER TABLE "RewardsLeg" ADD CONSTRAINT "RewardsLeg_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
