import type { OverageInvoice, Prisma } from '@prisma/client';
import { OVERAGE, PLANS, completedSlices, responseOverageFCFA, sliceAt, type PlanKey } from '@surveyflow/shared';
import { env } from '../config/env';
import { conflict, notFound, paymentRequired } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { audit, type AuditContext } from './audit';
import { sendMail } from './mail';

/**
 * Responses beyond a paid plan (PAY-09). What is built, and what is deliberately not:
 *  - NOTHING IS TAKEN. Mobile Money has no card on file to debit, so "automatic" means the invoice is made by itself at the end of each month and sent; paying it is the owner's own
 *    act, through the same payment page as everything else. (A card on file would need a different PSP agreement and a mandate: not built.)
 *  - OPT-IN. Until the owner agrees (Billing, with the rate in front of them) no invoice is made. Responses are never refused either way: a participant's answers cannot be dropped
 *    mid-survey.
 *  - A WARNING at 80 percent and again at 100 percent of the month's allowance, once each per month, to every paid plan: nobody is surprised.
 *  - BY THE MONTH, not by the subscription period (twelve months for an annual plan): a month is invoiced once, whatever early renewals or upgrades do to the period.
 *  - Consequences of not paying are a term of the contract that counsel has not written (docs/BACKLOG.md): by default nothing happens. OVERAGE_BLOCK_SENDS_AFTER_DAYS can stop NEW SENDS
 *    (never responses) once an invoice is that many days overdue.
 */
const DAY = 86_400_000;
const PAID_STATUSES = ['active', 'past_due'] as const;
type Db = Prisma.TransactionClient | typeof prisma;

export async function setOverageOptIn(userId: string, on: boolean, ctx: AuditContext) {
  await prisma.user.update({ where: { id: userId }, data: { overageOptIn: on, overageOptInAt: on ? new Date() : null } });
  await audit(ctx, { action: on ? 'overage_opt_in' : 'overage_opt_out' });
  return overageState(userId);
}

export async function overageState(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { overageOptIn: true, overageOptInAt: true } });
  const invoices = await prisma.overageInvoice.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 24 });
  return {
    optIn: u.overageOptIn, optInAt: u.overageOptInAt, per100: OVERAGE.responsesBlockFCFA, block: OVERAGE.responsesBlockSize,
    invoices: invoices.map(invoiceDto),
  };
}

export const invoiceDto = (i: OverageInvoice) => ({ id: i.id, period: i.period, plan: i.plan, allowance: i.allowance, responses: i.responses, units: i.units, amountFCFA: i.amountFCFA, status: i.status, dueAt: i.dueAt, paidAt: i.paidAt });

export async function getOpenInvoice(userId: string, id: string): Promise<OverageInvoice> {
  const inv = await prisma.overageInvoice.findFirst({ where: { id, userId } });
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'open') throw conflict('invoice_not_open', 'This invoice is already settled.');
  return inv;
}

/** Responses collected (completed) in one month of the subscription. */
const responsesIn = (db: Db, userId: string, start: Date, end: Date) => db.surveyRecipient.count({ where: { status: 'completed', completedAt: { gte: start, lt: end }, survey: { userId } } });

/**
 * Month by month: every month of every paid subscription that is over and was not invoiced yet. Hourly, leader only (jobs/scheduler.ts). The 80 and 100 percent warnings are sent
 * from here too, for the month that is running now.
 */
export async function runOverageBilling(now = new Date(), log: { warn: (o: unknown, m?: string) => void } = console as never) {
  const subs = await prisma.subscription.findMany({
    where: { amountFCFA: { gt: 0 }, status: { in: [...PAID_STATUSES] } },
    include: { user: { select: { id: true, email: true, name: true, locale: true, overageOptIn: true } } },
  });
  let invoiced = 0, warned = 0;
  for (const sub of subs) {
    const plan = sub.plan as PlanKey;
    if (plan === 'trial') continue;
    const allowance = PLANS[plan].limits.responsesPerMonth;
    const lang = sub.user.locale === 'en' ? 'en' : 'fr';

    // Months that are over.
    if (sub.user.overageOptIn) {
      for (const m of completedSlices(sub.currentPeriodStart, sub.currentPeriodEnd, now)) {
        const created = await invoiceSlice(sub.user, plan, allowance, m.start, m.end, now);
        if (created) {
          invoiced++;
          await sendMail(sub.user.email, 'overage_invoice', lang, { name: sub.user.name, what: created.period, rows: created.responses - allowance, count: created.amountFCFA, when: created.dueAt.toISOString().slice(0, 10), url: `${env.webBaseUrl}/billing` })
            .then(() => prisma.overageInvoice.update({ where: { id: created.id }, data: { noticeAt: new Date() } }))
            .catch((err) => log.warn({ err: (err as Error).message }, 'overage invoice mail failed'));
        }
      }
    }

    // The month that is running: a warning at 80 and at 100 percent, once each.
    const month = sliceAt(sub.currentPeriodStart, sub.currentPeriodEnd, now);
    if (month.start.getTime() <= now.getTime() && now.getTime() < month.end.getTime()) {
      const used = await responsesIn(prisma, sub.userId, month.start, month.end);
      for (const level of [100, 80] as const) {
        if (used * 100 < allowance * level) continue;
        const key = `sf:overage:warn:${sub.userId}:${month.start.toISOString().slice(0, 10)}:${level}`;
        if ((await redis.set(key, '1', 'EX', 40 * 86_400, 'NX')) !== 'OK') break;
        await sendMail(sub.user.email, 'overage_warning', lang, { name: sub.user.name, count: level, rows: used, what: String(allowance), enabled: sub.user.overageOptIn, url: `${env.webBaseUrl}/billing` }).catch((err) => log.warn({ err: (err as Error).message }, 'overage warning mail failed'));
        warned++;
        break; // at 100 the 80 warning is not needed any more
      }
    }
  }
  return { invoiced, warned };
}

async function invoiceSlice(user: { id: string; overageOptIn: boolean }, plan: PlanKey, allowance: number, start: Date, end: Date, now: Date): Promise<OverageInvoice | null> {
  if (!user.overageOptIn) return null;
  const period = start.toISOString().slice(0, 10);
  if (await prisma.overageInvoice.findUnique({ where: { userId_period: { userId: user.id, period } }, select: { id: true } })) return null;
  const responses = await responsesIn(prisma, user.id, start, end);
  const amountFCFA = responseOverageFCFA(plan, responses);
  if (amountFCFA <= 0) return null;
  const units = Math.ceil((responses - allowance) / OVERAGE.responsesBlockSize);
  try {
    const inv = await prisma.overageInvoice.create({ data: { userId: user.id, period, plan, allowance, responses, units, amountFCFA, dueAt: new Date(now.getTime() + env.OVERAGE_DUE_DAYS * DAY) } });
    await audit({ userId: user.id }, { action: 'overage_invoice', meta: { period, units, amountFCFA } });
    return inv;
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return null; // another replica made it a moment ago
    throw err;
  }
}

/**
 * The month an upgrade cuts short: the owner moves to another plan and the period they paid for is replaced, so the month in progress is invoiced now, against the full month's
 * allowance (the customer's favour), instead of being lost. Called from the settlement of the upgrade, never throws.
 */
export async function invoiceCutShortMonth(sub: { userId: string; plan: string; currentPeriodStart: Date; currentPeriodEnd: Date; amountFCFA: number }, now = new Date()): Promise<void> {
  try {
    if (sub.amountFCFA <= 0 || sub.plan === 'trial') return;
    const user = await prisma.user.findUnique({ where: { id: sub.userId }, select: { id: true, overageOptIn: true } });
    if (!user?.overageOptIn) return;
    const plan = sub.plan as PlanKey;
    const month = sliceAt(sub.currentPeriodStart, sub.currentPeriodEnd, now);
    await invoiceSlice(user, plan, PLANS[plan].limits.responsesPerMonth, month.start, now, now);
  } catch {
    /* an invoice must never fail the payment that is upgrading the plan */
  }
}

/** Stops NEW SENDS (never responses) once an overage invoice has been overdue for OVERAGE_BLOCK_SENDS_AFTER_DAYS. Off by default. */
export async function assertNoOverdueOverage(userId: string, now = new Date()): Promise<void> {
  if (!env.OVERAGE_BLOCK_SENDS_AFTER_DAYS) return;
  const limit = new Date(now.getTime() - env.OVERAGE_BLOCK_SENDS_AFTER_DAYS * DAY);
  const overdue = await prisma.overageInvoice.findFirst({ where: { userId, status: 'open', dueAt: { lt: limit } }, select: { id: true } });
  if (overdue) throw paymentRequired('overage_due', 'An invoice for responses beyond your plan is overdue. Pay it from the Billing page to send new surveys. Your participants can still answer.', {});
}
