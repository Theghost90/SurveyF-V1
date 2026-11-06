-- WA-05, WA-06: join a survey from a link or a QR code, and the limits on what that can win.
ALTER TABLE "Survey"
  ADD COLUMN "joinCode" TEXT,
  ADD COLUMN "joinEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "joinExpiresAt" TIMESTAMP(3),
  ADD COLUMN "joinMax" INTEGER,
  ADD COLUMN "joinCountries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "joinGifts" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "joinGiftMax" INTEGER;
CREATE UNIQUE INDEX "Survey_joinCode_key" ON "Survey"("joinCode");
ALTER TABLE "SurveyRecipient" ADD COLUMN "via" TEXT;
CREATE INDEX "SurveyRecipient_surveyId_via_idx" ON "SurveyRecipient"("surveyId", "via");
