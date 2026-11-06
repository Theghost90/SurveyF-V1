import type { FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { addRows, distinctAdd, hit, peek } from '../../lib/counters';
import { AppError } from '../../lib/errors';
import { describeAgent } from '../../lib/user-agent';
import { clientIp, ipPrefix } from '../../lib/client-ip';
import { prisma } from '../../lib/prisma';
import { audit, auditContext, auditStrict } from '../audit';
import { sendMail, sendMailInBackground } from '../mail';
import { assertStepUp } from './step-up';

/**
 * Participant data leaving the account (finding 4): one stolen login must not be able to carry away every contact.
 *
 *   exports (PDF, Excel, CSV, Google Sheets)   a daily cap on downloads and on rows; from STEP_UP_EXPORT_ROWS rows a recent "confirm it is you";
 *                                              an e-mail to the owner for every one ("a file of N rows was downloaded from <browser, place>")
 *   bulk delete                                the same, from STEP_UP_BULK_ROWS contacts
 *   reveal of a hidden number                  a per-minute-ish burst limit, a daily cap, and an audit row written BEFORE the number is returned
 * Phone numbers are masked in every list the API returns; these are the only doors to a full number.
 */
const DAY = 86_400;

const placeOf = (req: FastifyRequest): string => {
  const ip = clientIp(req);
  return `${describeAgent(req.headers['user-agent']).label}${ipPrefix(ip) ? `, ${ipPrefix(ip)}` : ''}`;
};
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

async function owner(userId: string) {
  return prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, name: true, locale: true } });
}

async function assertCap(userId: string, bucket: string, rows: number): Promise<void> {
  const [n, r] = await Promise.all([peek(`${bucket}:n:${userId}`), peek(`${bucket}:rows:${userId}`)]);
  if (n >= env.EXPORT_DAILY_LIMIT || r + rows > env.EXPORT_DAILY_ROWS) {
    throw new AppError(429, 'export_cap', 'The daily limit for downloads of participant data was reached. It resets within 24 hours; contact support if you need more today.');
  }
}

/** Adds one download and `rows` rows to today's totals (the expiry is set by the first write of each counter). */
async function count(userId: string, bucket: string, rows: number): Promise<void> {
  await hit(`${bucket}:n:${userId}`, DAY);
  await addRows(`${bucket}:rows:${userId}`, rows, DAY);
}

export type ExportKind = 'pdf' | 'excel' | 'csv' | 'sheets';

/** Call before building the file. Throws 429 (cap), 403 `step_up_required` / `two_factor_required`; otherwise records the download and e-mails the owner. */
export async function guardExport(req: FastifyRequest, opts: { kind: ExportKind; rows: number; surveyId: string; surveyTitle: string; /** Turning Sheets auto-sync on (or confirming it again) needs the confirmation at any size (SEC-20). */ forceStepUp?: boolean }): Promise<void> {
  await assertCap(req.userId, 'exp', opts.rows);
  if (opts.rows >= env.STEP_UP_EXPORT_ROWS || opts.forceStepUp) await assertStepUp(req);
  await count(req.userId, 'exp', opts.rows);
  await auditStrict(auditContext(req), { action: 'export', targetType: 'survey', targetId: opts.surveyId, meta: { kind: opts.kind, rows: opts.rows } });
  const o = await owner(req.userId);
  await sendMail(o.email, 'export_alert', o.locale === 'en' ? 'en' : 'fr', { name: o.name, rows: opts.rows, what: `${opts.kind.toUpperCase()}, ${opts.surveyTitle}`, when: stamp(), place: placeOf(req) });
}

/**
 * Call before building the whole-account download (DAT-01). It always needs a recent "confirm it is you": the file holds every participant's name and number.
 * Counted against the daily export caps, written to the audit trail BEFORE the file exists, and e-mailed to the owner.
 */
export async function guardAccountExport(req: FastifyRequest): Promise<void> {
  const rows = await prisma.contact.count({ where: { userId: req.userId } });
  if ((await peek(`acct-exp:n:${req.userId}`)) >= env.ACCOUNT_EXPORT_PER_DAY) {
    throw new AppError(429, 'export_cap', 'You already downloaded your account data today. It can be done again within 24 hours.');
  }
  // NOT assertCap: the daily rows cap would shut out, for good, an owner whose list is bigger than the cap, and the law gives everybody a copy of their data (s.43).
  // What contains a stolen session here is the confirmation every time, the few downloads a day, the alert e-mail and the trail; the rows still count towards
  // today's total, so every other download that day is held to the shared cap.
  await assertStepUp(req);
  await hit(`acct-exp:n:${req.userId}`, DAY);
  await count(req.userId, 'exp', rows);
  await auditStrict(auditContext(req), { action: 'account_export', meta: { people: rows } });
  const o = await owner(req.userId);
  await sendMail(o.email, 'export_alert', o.locale === 'en' ? 'en' : 'fr', { name: o.name, rows, what: o.locale === 'en' ? 'whole account' : 'compte entier', when: stamp(), place: placeOf(req) });
}

/** Call before deleting `rows` contacts at once. */
export async function guardBulkDelete(req: FastifyRequest, rows: number): Promise<void> {
  await assertCap(req.userId, 'bulk', rows);
  const big = rows > env.STEP_UP_BULK_ROWS;
  if (big) await assertStepUp(req);
  await count(req.userId, 'bulk', rows);
  await auditStrict(auditContext(req), { action: 'bulk_delete', targetType: 'contact', meta: { rows } });
  if (big) {
    const o = await owner(req.userId);
    await sendMail(o.email, 'bulk_delete_alert', o.locale === 'en' ? 'en' : 'fr', { name: o.name, rows, when: stamp(), place: placeOf(req) });
  }
}

/** Throws 429 when the owner is revealing numbers faster than a person could use them. The audit row is written first and its failure stops the reveal. */
export async function guardReveal(req: FastifyRequest, contactId: string): Promise<void> {
  if ((await hit(`reveal:burst:${req.userId}`, 600)) > 30) throw new AppError(429, 'reveal_cap', 'You are revealing numbers very fast. Wait a few minutes, or use an export if you need many.');
  if ((await hit(`reveal:day:${req.userId}`, DAY)) > env.REVEAL_PER_DAY) throw new AppError(429, 'reveal_cap', 'The daily limit for revealing numbers was reached. It resets within 24 hours.');
  await auditStrict(auditContext(req), { action: 'contact_reveal', targetType: 'contact', targetId: contactId });
}


/**
 * SEC-20: names and free-text answers are shown in lists (only numbers are masked), so a stolen session could page through every participant. Call with the ids of the
 * participants a list is about to show. The distinct people listed in 24 hours are counted (looking at the same page again is free):
 *   past READ_SOFT_PEOPLE   the owner is e-mailed once and a recent "confirm it is you" is needed (403 `step_up_required`, the website opens its dialog and repeats the call)
 *   past READ_HARD_PEOPLE   429 `read_cap` until the window has passed; an export is the way to take more, and it is capped, confirmed and e-mailed too
 */
export async function guardRead(req: FastifyRequest, participantIds: string[]): Promise<void> {
  if (!participantIds.length) return;
  const people = await distinctAdd(`read:people:${req.userId}`, participantIds, DAY);
  if (people > env.READ_HARD_PEOPLE) {
    if ((await hit(`read:blocked:${req.userId}`, DAY)) === 1) await audit(auditContext(req), { action: 'bulk_read_blocked', meta: { people } });
    throw new AppError(429, 'read_cap', 'You have looked at a very large number of participants today. The lists resume within 24 hours; use a download if you need more.');
  }
  if (people > env.READ_SOFT_PEOPLE) {
    if ((await hit(`read:alert:${req.userId}`, DAY)) === 1) {
      await audit(auditContext(req), { action: 'bulk_read', meta: { people } });
      const o = await owner(req.userId);
      sendMailInBackground(o.email, 'bulk_read_alert', o.locale === 'en' ? 'en' : 'fr', { name: o.name, count: env.READ_SOFT_PEOPLE, when: stamp(), place: placeOf(req) });
    }
    await assertStepUp(req);
  }
}
