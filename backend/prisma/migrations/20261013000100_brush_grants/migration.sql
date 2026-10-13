-- Brush entitlements: who may use non-free brushes, and until when.
-- The brush catalog itself lives in shared/brushes.json.

-- CreateEnum
CREATE TYPE "GrantSource" AS ENUM ('PURCHASE', 'AD_REWARD', 'PROMO');

-- CreateTable
CREATE TABLE "BrushGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brushId" TEXT NOT NULL,
    "source" "GrantSource" NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrushGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrushGrant_userId_brushId_source_key" ON "BrushGrant"("userId", "brushId", "source");

-- CreateIndex
CREATE INDEX "BrushGrant_userId_idx" ON "BrushGrant"("userId");

-- AddForeignKey
ALTER TABLE "BrushGrant" ADD CONSTRAINT "BrushGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
