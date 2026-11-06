-- Multi-currency: the gift wallet, gift amounts and payments follow the owner's currency; rates are live (FxRate).
-- Purely additive. The FCFA-named columns keep their names (Prisma maps them: giftBalance, giftAmount, amount, fee, delta) and
-- their existing values stay correct: every pre-existing wallet, gift and payment is in CFA francs.

-- AlterTable
ALTER TABLE "GiftDelivery" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'XAF',
ADD COLUMN     "payoutXAF" INTEGER;

-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN     "amountXAF" INTEGER,
ADD COLUMN     "fxRate" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "giftCurrency" TEXT;

-- CreateTable
CREATE TABLE "FxRate" (
    "currency" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("currency")
);

-- Backfill: what already exists is in CFA francs, so the payout amount equals the gift amount and a wallet that ever held money is an XAF wallet.
UPDATE "GiftDelivery" SET "payoutXAF" = "amountFCFA" WHERE "amountFCFA" IS NOT NULL;
UPDATE "PaymentTransaction" SET "amountXAF" = "amount" WHERE "currency" IN ('XAF', 'XOF');
UPDATE "User" SET "giftCurrency" = 'XAF' WHERE "giftBalanceFCFA" > 0 OR EXISTS (SELECT 1 FROM "WalletEntry" w WHERE w."userId" = "User"."id");
