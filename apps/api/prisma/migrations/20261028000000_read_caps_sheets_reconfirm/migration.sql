-- SEC-20: Google Sheets auto-sync has to be confirmed again after SHEETS_AUTOSYNC_DAYS (the other half of SEC-20, the read caps, lives in Redis and needs no table).
ALTER TABLE "SheetSync" ADD COLUMN "autoSyncConfirmedAt" TIMESTAMP(3);
ALTER TABLE "SheetSync" ADD COLUMN "autoSyncPausedAt" TIMESTAMP(3);

-- A sync that is already running starts its first window now (it was confirmed when it was turned on, whenever that was).
UPDATE "SheetSync" SET "autoSyncConfirmedAt" = now() WHERE "autoSync" = true;
