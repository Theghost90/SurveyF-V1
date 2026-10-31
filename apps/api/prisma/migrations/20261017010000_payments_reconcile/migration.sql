-- A payment the provider confirmed but that a person must look at (underpaid, wrong currency, lower plan than the active one, activation error).
ALTER TYPE "TransactionStatus" ADD VALUE IF NOT EXISTS 'review';

-- Reconciliation: when the provider was last asked, and every provider a payment was started at.
ALTER TABLE "PaymentTransaction" ADD COLUMN "lastCheckedAt" TIMESTAMP(3);
ALTER TABLE "PaymentTransaction" ADD COLUMN "attempts" JSONB;

-- The reconciliation job selects by status and age.
CREATE INDEX "PaymentTransaction_status_createdAt_idx" ON "PaymentTransaction"("status", "createdAt");
