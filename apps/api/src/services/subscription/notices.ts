import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { notifyOwner } from '../notify';

/**
 * Renewal notices. Nothing renews by itself here (Mobile Money has no card-on-file debit), so the first sign of a lapse used to be the
 * account turning "overdue", three days before the surveys stop. These two notices come BEFORE that:
 *  - three days before the period ends: "your plan ends on …, renew";
 *  - once when it has lapsed into the grace window: "overdue, renew before … to avoid suspension".
 * Each goes out once (a compare-and-set on a timestamp that every successful payment resets). They are sent by WhatsApp from SurveyFlow's own
 * number, which is best effort (a free-form message only arrives inside the 24 h window the owner opens by messaging that number): the in-app
 * banner is the dependable channel, this is the nudge that reaches people who do not open the app.
 */
const DAY = 86_400_000;
export const RENEWAL_NOTICE_DAYS = 3;

const link = () => `${env.webOrigins[0]}/billing`;
const day = (d: Date, locale: string) => new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);
const label = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);

export const renewalNoticeText = (locale: string, plan: string, end: Date) => locale === 'fr'
  ? `⏰ SurveyFlow : votre forfait ${label(plan)} se termine le ${day(end, 'fr')}. Le renouvellement n’est pas automatique : renouvelez avant cette date pour que vos sondages continuent : ${link()}`
  : `⏰ SurveyFlow: your ${label(plan)} plan ends on ${day(end, 'en')}. Renewal is not automatic: renew before then so your surveys keep running: ${link()}`;

export const overdueNoticeText = (locale: string, graceEnd: Date | null) => locale === 'fr'
  ? `⚠️ SurveyFlow : le paiement de votre abonnement est en retard.${graceEnd ? ` Renouvelez avant le ${day(graceEnd, 'fr')}` : ' Renouvelez vite'} pour éviter la suspension (vous ne pourrez plus publier ni envoyer) : ${link()}`
  : `⚠️ SurveyFlow: your subscription payment is overdue.${graceEnd ? ` Renew before ${day(graceEnd, 'en')}` : ' Renew soon'} to avoid suspension (you could no longer publish or send): ${link()}`;

export async function runRenewalNotices(now = new Date()): Promise<{ renewal: number; overdue: number }> {
  let renewal = 0;
  let overdue = 0;

  const ending = await prisma.subscription.findMany({
    where: { status: 'active', amountFCFA: { gt: 0 }, cancelAtPeriodEnd: false, reminderSentAt: null, currentPeriodEnd: { gt: now, lte: new Date(now.getTime() + RENEWAL_NOTICE_DAYS * DAY) } },
    include: { user: { select: { id: true, locale: true } } }, take: 500,
  });
  for (const s of ending) {
    const claimed = await prisma.subscription.updateMany({ where: { id: s.id, reminderSentAt: null }, data: { reminderSentAt: now } });
    if (!claimed.count) continue;
    await notifyOwner(s.user.id, renewalNoticeText(s.user.locale, s.plan, s.currentPeriodEnd));
    renewal++;
  }

  const late = await prisma.subscription.findMany({
    where: { status: 'past_due', pastDueNoticeAt: null }, include: { user: { select: { id: true, locale: true } } }, take: 500,
  });
  for (const s of late) {
    const claimed = await prisma.subscription.updateMany({ where: { id: s.id, pastDueNoticeAt: null }, data: { pastDueNoticeAt: now } });
    if (!claimed.count) continue;
    await notifyOwner(s.user.id, overdueNoticeText(s.user.locale, s.graceEndsAt));
    overdue++;
  }
  return { renewal, overdue };
}
