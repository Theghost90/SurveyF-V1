-- Gift wallet: the SURVEY OWNER funds participant gifts from a prepaid FCFA balance (docs/DECISIONS.md §3.1).

-- AlterEnum
ALTER TYPE "GiftStatus" ADD VALUE 'unfunded';

-- AlterTable
ALTER TABLE "GiftDelivery" ADD COLUMN     "feeFCFA" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "notifyViaTemplate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'subscription',
ALTER COLUMN "plan" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "giftBalanceFCFA" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "WalletEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deltaFCFA" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletEntry_userId_createdAt_idx" ON "WalletEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletEntry_refId_idx" ON "WalletEntry"("refId");

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Defence in depth: the application only ever changes the balance with a guarded UPDATE, and this makes
-- a negative balance impossible even if some future code path forgets the guard. (Prisma does not model CHECKs.)
ALTER TABLE "User" ADD CONSTRAINT "User_giftBalanceFCFA_nonnegative" CHECK ("giftBalanceFCFA" >= 0);
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_kind_check" CHECK ("kind" IN ('topup', 'gift_debit', 'gift_refund'));
