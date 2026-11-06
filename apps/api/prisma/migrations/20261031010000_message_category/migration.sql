-- WA-03: the category an invitation is sent under, and what Meta announces about a template's category.
ALTER TABLE "Survey" ADD COLUMN "followsTransaction" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MessageTemplate" ADD COLUMN "categoryPending" TEXT, ADD COLUMN "categoryPendingAt" TIMESTAMP(3);
ALTER TABLE "SendJob" ADD COLUMN "category" TEXT;
