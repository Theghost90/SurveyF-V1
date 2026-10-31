-- DAT-01: erasure with a 30-day grace period, and the minimal financial archive that outlives a deleted account.
ALTER TABLE "User" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "deletionScheduledFor" TIMESTAMP(3);

CREATE TABLE "FinancialArchive" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "ownerRef" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT,
    "purpose" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "keepUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialArchive_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinancialArchive_ownerRef_idx" ON "FinancialArchive"("ownerRef");
CREATE INDEX "FinancialArchive_keepUntil_idx" ON "FinancialArchive"("keepUntil");
