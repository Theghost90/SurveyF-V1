-- PAY-13: payout limits. A gift can now be held by a safety limit, and the daily caps count what was committed in the last 24 hours.
ALTER TYPE "GiftStatus" ADD VALUE IF NOT EXISTS 'held';
ALTER TABLE "GiftDelivery" ADD COLUMN "committedAt" TIMESTAMP(3), ADD COLUMN "committedXAF" INTEGER, ADD COLUMN "heldReason" TEXT, ADD COLUMN "heldUntil" TIMESTAMP(3);
CREATE INDEX "GiftDelivery_committedAt_idx" ON "GiftDelivery"("committedAt");
CREATE INDEX "GiftDelivery_status_heldUntil_idx" ON "GiftDelivery"("status", "heldUntil");
