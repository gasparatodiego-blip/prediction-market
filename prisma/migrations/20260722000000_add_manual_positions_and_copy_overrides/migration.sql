-- CreateTable
CREATE TABLE "ManualPosition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "traderId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "conditionId" TEXT,
    "outcome" TEXT NOT NULL DEFAULT '—',
    "side" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "size" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'open',
    "closedPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyCloseOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "walletAddr" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "closePercent" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "origin" TEXT NOT NULL DEFAULT 'user_override',
    "resultNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "CopyCloseOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualPosition_userId_idx" ON "ManualPosition"("userId");

-- CreateIndex
CREATE INDEX "ManualPosition_userId_traderId_idx" ON "ManualPosition"("userId", "traderId");

-- CreateIndex
CREATE INDEX "CopyCloseOverride_status_idx" ON "CopyCloseOverride"("status");

-- CreateIndex
CREATE INDEX "CopyCloseOverride_userId_idx" ON "CopyCloseOverride"("userId");

-- AddForeignKey
ALTER TABLE "ManualPosition" ADD CONSTRAINT "ManualPosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

