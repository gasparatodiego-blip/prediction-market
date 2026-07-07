-- CreateTable
CREATE TABLE "RewardsPlacement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'both',
    "qtyPerSide" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "distanceC" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "onFill" TEXT NOT NULL DEFAULT 'requote',
    "newsMode" TEXT NOT NULL DEFAULT 'withdraw',
    "mode" TEXT NOT NULL DEFAULT 'paper',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardsPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RewardsPlacement_userId_marketId_key" ON "RewardsPlacement"("userId", "marketId");

-- AddForeignKey
ALTER TABLE "RewardsPlacement" ADD CONSTRAINT "RewardsPlacement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
