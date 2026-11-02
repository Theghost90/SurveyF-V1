-- PAY-12: credit for the unused days of the plan an upgrade replaces. PAY-09: invoices for responses beyond the plan, opt-in.
ALTER TABLE "PaymentTransaction"
  ADD COLUMN "creditFCFA" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "creditFromPlan" TEXT,
  ADD COLUMN "creditFromPeriodEnd" TIMESTAMP(3),
  ADD COLUMN "overageInvoiceId" TEXT;
ALTER TABLE "User"
  ADD COLUMN "overageOptIn" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "overageOptInAt" TIMESTAMP(3);
CREATE TABLE "OverageInvoice" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "plan" TEXT NOT NULL,
  "allowance" INTEGER NOT NULL,
  "responses" INTEGER NOT NULL,
  "units" INTEGER NOT NULL,
  "amountFCFA" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "dueAt" TIMESTAMP(3) NOT NULL,
  "paidAt" TIMESTAMP(3),
  "noticeAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OverageInvoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OverageInvoice_userId_period_key" ON "OverageInvoice"("userId", "period");
CREATE INDEX "OverageInvoice_userId_status_idx" ON "OverageInvoice"("userId", "status");
ALTER TABLE "OverageInvoice" ADD CONSTRAINT "OverageInvoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
