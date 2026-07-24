-- CreateTable
CREATE TABLE "MakerUniverseSelection" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "filters" JSONB NOT NULL,
    "venues" TEXT[] DEFAULT ARRAY['polymarket']::TEXT[],
    "allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "denylist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxMarkets" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "MakerUniverseSelection_pkey" PRIMARY KEY ("id")
);

