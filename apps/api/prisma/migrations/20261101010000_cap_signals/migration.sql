-- BIZ-03: facts about the free plan's cap on different people reached (counts only).
CREATE TABLE "CapSignal" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "cap" INTEGER,
  "reached" INTEGER NOT NULL,
  "wanted" INTEGER,
  "plan" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CapSignal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CapSignal_userId_at_idx" ON "CapSignal"("userId", "at");
CREATE INDEX "CapSignal_kind_at_idx" ON "CapSignal"("kind", "at");
ALTER TABLE "CapSignal" ADD CONSTRAINT "CapSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
