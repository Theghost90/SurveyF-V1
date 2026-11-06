-- AlterTable
ALTER TABLE "OwnerPhone" ADD COLUMN     "alerts" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastInboundAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BotAlert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotAlert_userId_createdAt_idx" ON "BotAlert"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BotAlert_surveyId_kind_key_key" ON "BotAlert"("surveyId", "kind", "key");

-- AddForeignKey
ALTER TABLE "BotAlert" ADD CONSTRAINT "BotAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

