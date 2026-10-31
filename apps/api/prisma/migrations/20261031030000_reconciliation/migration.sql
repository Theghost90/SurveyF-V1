-- PAY-02: what the payment providers hold (typed in or read), and one row per daily reconciliation run.
CREATE TABLE "ProviderBalance" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "available" DOUBLE PRECISION NOT NULL,
  "asOf" TIMESTAMP(3) NOT NULL,
  "source" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderBalance_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProviderBalance_provider_currency_asOf_idx" ON "ProviderBalance"("provider", "currency", "asOf");

CREATE TABLE "ReconciliationRun" (
  "id" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL,
  "ok" BOOLEAN NOT NULL,
  "obligationsXAF" INTEGER,
  "assetsXAF" INTEGER,
  "findings" JSONB NOT NULL,
  "report" JSONB NOT NULL,
  CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReconciliationRun_at_idx" ON "ReconciliationRun"("at");
