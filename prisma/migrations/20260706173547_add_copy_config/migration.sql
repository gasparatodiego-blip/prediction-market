-- CreateTable
CREATE TABLE "CopyConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddr" TEXT NOT NULL,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pctPerOrder" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "maxOpenPositions" INTEGER NOT NULL DEFAULT 5,
    "exitMode" TEXT NOT NULL DEFAULT 'mirror',
    "tpPct" DOUBLE PRECISION,
    "slPct" DOUBLE PRECISION,
    "mode" TEXT NOT NULL DEFAULT 'paper',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CopyConfig_userId_walletAddr_key" ON "CopyConfig"("userId", "walletAddr");

-- AddForeignKey
ALTER TABLE "CopyConfig" ADD CONSTRAINT "CopyConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
