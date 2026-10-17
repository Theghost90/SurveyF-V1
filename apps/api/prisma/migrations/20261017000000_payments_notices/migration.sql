-- Payments hardening (major): remember that the "overdue" notice was sent, so a customer is told once per lapse.
ALTER TABLE "Subscription" ADD COLUMN "pastDueNoticeAt" TIMESTAMP(3);
