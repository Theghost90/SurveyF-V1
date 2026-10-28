import type { FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { addRows, hit, peek } from '../../lib/counters';
import { AppError } from '../../lib/errors';
import { describeAgent } from '../../lib/user-agent';
import { clientIp, ipPrefix } from '../../lib/client-ip';
import { prisma } from '../../lib/prisma';
import { auditContext, auditStrict } from '../audit';
import { sendMail } from '../mail';
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
export async function guardExport(req: FastifyRequest, opts: { kind: ExportKind; rows: number; surveyId: string; surveyTitle: string }): Promise<void> {
  await assertCap(req.userId, 'exp', opts.rows);
  if (opts.rows >= env.STEP_UP_EXPORT_ROWS) await assertStepUp(req);
  await count(req.userId, 'exp', opts.rows);
  await auditStrict(auditContext(req), { action: 'export', targetType: 'survey', targetId: opts.surveyId, meta: { kind: opts.kind, rows: opts.rows } });
  const o = await owner(req.userId);
  await sendMail(o.email, 'export_alert', o.locale === 'en' ? 'en' : 'fr', { name: o.name, rows: opts.rows, what: `${opts.kind.toUpperCase()}, ${opts.surveyTitle}`, when: stamp(), place: placeOf(req) });
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

