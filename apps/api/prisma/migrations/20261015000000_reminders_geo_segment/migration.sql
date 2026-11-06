-- Automatic reminders (survey kind + deadline + per-profile switches), recipient reminder tracking, owner segment.

-- AlterTable
ALTER TABLE "Survey" ADD COLUMN     "autoRemindAbandoners" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoRemindNonResponders" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deadlineAt" TIMESTAMP(3),
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'general';

-- AlterTable
ALTER TABLE "SurveyRecipient" ADD COLUMN     "abandonedAt" TIMESTAMP(3),
ADD COLUMN     "followupAt" TIMESTAMP(3),
ADD COLUMN     "reminderAuto" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reminderRule" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "segment" TEXT;


-- Backfill: participants already flagged abandoned get an abandonedAt so the reminder rules can anchor on it.
UPDATE "SurveyRecipient" SET "abandonedAt" = COALESCE("startedAt", "sentAt", "createdAt") WHERE "status" = 'abandoned' AND "abandonedAt" IS NULL;
