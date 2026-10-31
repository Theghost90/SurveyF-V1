-- Analytics Bot: phones proven (by a one-time code) to belong to an owner.
CREATE TABLE "OwnerPhone" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OwnerPhone_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OwnerPhone_phone_key" ON "OwnerPhone"("phone");
CREATE INDEX "OwnerPhone_userId_idx" ON "OwnerPhone"("userId");
ALTER TABLE "OwnerPhone" ADD CONSTRAINT "OwnerPhone_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
