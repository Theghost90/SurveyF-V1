-- WA-11..WA-13 (D-19): Embedded Signup v5 with coexistence. How each number is connected, the sync state, and why a number was disconnected.
ALTER TABLE "WhatsAppAccount"
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'cloud',
  ADD COLUMN "declaredSituation" TEXT,
  ADD COLUMN "signupVersion" TEXT,
  ADD COLUMN "registeredAt" TIMESTAMP(3),
  ADD COLUMN "registerPin" TEXT,
  ADD COLUMN "syncState" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "syncStartedAt" TIMESTAMP(3),
  ADD COLUMN "contactsReceived" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "historyProgress" INTEGER,
  ADD COLUMN "historyThreads" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAppActivityAt" TIMESTAMP(3),
  ADD COLUMN "disconnectReason" TEXT,
  ADD COLUMN "disconnectedBy" TEXT,
  ADD COLUMN "disconnectedAt" TIMESTAMP(3);
