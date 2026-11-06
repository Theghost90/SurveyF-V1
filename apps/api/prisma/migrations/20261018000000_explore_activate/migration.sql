-- Explore / Activate. Explore (internal plan key "trial") has no clock any more: it is capped by usage (1 survey, 5 people), so its usage window is the life of the account.
UPDATE "Subscription" SET "currentPeriodEnd" = "currentPeriodStart" + interval '100 years' WHERE "status" = 'trial';
UPDATE "User" SET "trialEndsAt" = NULL;

-- The old "free Starter" (an unpaid trial or a cancelled plan that kept Starter limits for free) becomes Explore: nobody keeps a free Starter.
UPDATE "Subscription" SET "plan" = 'trial', "status" = 'trial', "amountFCFA" = 0, "paymentMethod" = NULL, "cancelAtPeriodEnd" = false,
  "currentPeriodStart" = now(), "currentPeriodEnd" = now() + interval '100 years'
  WHERE "amountFCFA" = 0 AND "plan" = 'starter' AND "status" IN ('active', 'cancelled');
UPDATE "User" SET "plan" = 'trial' WHERE "id" IN (SELECT "userId" FROM "Subscription" WHERE "plan" = 'trial');

-- First time each milestone happens for an owner (see services/funnel.ts).
CREATE TABLE "FunnelEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "meta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FunnelEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FunnelEvent_userId_name_key" ON "FunnelEvent"("userId", "name");
CREATE INDEX "FunnelEvent_name_createdAt_idx" ON "FunnelEvent"("name", "createdAt");
ALTER TABLE "FunnelEvent" ADD CONSTRAINT "FunnelEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
