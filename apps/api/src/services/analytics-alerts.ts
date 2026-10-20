import { ALERT_MILESTONES, COUNTRY_CONFIG, OWNER_ALERT_DEFS, OWNER_ALERT_PAYLOADS, OWNER_ALERT_TEMPLATE, botAlertMessage, botAlertTemplateText, getPlan, type AlertKind, type BotLocale } from '@surveyflow/shared';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { getGateway } from './whatsapp/gateway';
import { platformCreds } from './whatsapp/accounts';

/**
 * Push alerts of the Analytics Bot: a milestone ("100 responses") and a slowdown ("no new answers for 48 h").
 *
 * Money: the bot speaks from SurveyFlow's OWN number, so a message OUTSIDE the owner's 24 h window is an approved template that SurveyFlow pays
 * for. Hence: (1) inside the window it is a free reply; (2) outside it, at most 3 templates a day and 15 a month per owner; (3) alerts are rare by
 * construction (five milestones per survey, one slowdown per survey per week); (4) every phone can mute them.
 */
export const ALERT_CAPS = { templatesPerDay: 3, templatesPerMonth: 15 } as const;
export const SLOWDOWN_HOURS = 48;
const WINDOW_MS = 24 * 3_600_000;

type Log = { warn: (o: unknown, m?: string) => void };
const noLog: Log = { warn: () => {} };
const isoWeek = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  return `${y}-W${String(Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7)).padStart(2, '0')}`;
};

/** Counts a template against the owner's caps; false (and nothing counted) when a cap is reached. */
async function takeTemplateSlot(userId: string): Promise<boolean> {
  const now = new Date();
  const dayKey = `sf:bot:tpl:d:${userId}:${now.toISOString().slice(0, 10)}`;
  const monKey = `sf:bot:tpl:m:${userId}:${now.toISOString().slice(0, 7)}`;
  const [d, m] = [await redis.incr(dayKey), await redis.incr(monKey)];
  if (d === 1) await redis.expire(dayKey, 2 * 86_400);
  if (m === 1) await redis.expire(monKey, 32 * 86_400);
  if (d > ALERT_CAPS.templatesPerDay || m > ALERT_CAPS.templatesPerMonth) { await redis.decr(dayKey); await redis.decr(monKey); return false; }
  return true;
}

/**
 * Decide and send ONE alert to every phone of the owner that wants it. The unique (survey, kind, key) row is written first, so the same
 * milestone is never sent twice, whichever completions race. Returns how the alert went out.
 */
export async function sendOwnerAlert(userId: string, surveyId: string, kind: AlertKind, key: string, params: { title: string; n?: number; rate?: number; hours?: number }, log: Log = noLog): Promise<'window' | 'template' | 'skipped' | 'duplicate'> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { locale: true, plan: true, ownerPhones: true } });
  if (!user || !getPlan(user.plan).features.analyticsBot) return 'skipped';
  // the unique (survey, kind, key) row is the lock: whoever inserts it sends, everyone else stops here
  if ((await prisma.botAlert.createMany({ data: [{ userId, surveyId, kind, key, channel: 'skipped' }], skipDuplicates: true })).count === 0) return 'duplicate';

  const creds = platformCreds();
  const locale: BotLocale = user.locale === 'en' ? 'en' : 'fr';
  const phones = user.ownerPhones.filter((p) => p.alerts);
  if (!creds || phones.length === 0) return 'skipped';
  const gw = getGateway();
  let channel: 'window' | 'template' | 'skipped' = 'skipped';
  for (const p of phones) {
    try {
      if (p.lastInboundAt && Date.now() - p.lastInboundAt.getTime() < WINDOW_MS) {
        await gw.sendMessage(creds, p.phone, botAlertMessage(kind, params, locale));
        if (channel === 'skipped') channel = 'window';
      } else if (await takeTemplateSlot(userId)) {
        await gw.sendTemplate(creds, p.phone, { name: OWNER_ALERT_TEMPLATE, language: locale, bodyParams: [botAlertTemplateText(kind, params, locale)], buttonPayloads: OWNER_ALERT_PAYLOADS });
        channel = 'template';
      }
    } catch (err) { log.warn({ err: (err as Error).message }, 'owner alert failed'); }
  }
  await prisma.botAlert.updateMany({ where: { surveyId, kind, key }, data: { channel } });
  return channel;
}

/** After a completion: the highest milestone now reached that was not alerted yet. (Racing completions: the unique row lets one through.) */
export async function checkMilestone(surveyId: string, log: Log = noLog): Promise<void> {
  const survey = await prisma.survey.findUnique({ where: { id: surveyId }, select: { id: true, userId: true, title: true } });
  if (!survey) return;
  const completed = await prisma.surveyRecipient.count({ where: { surveyId, status: 'completed' } });
  const reached = [...ALERT_MILESTONES].filter((m) => completed >= m).pop();
  if (!reached) return;
  const started = await prisma.surveyRecipient.count({ where: { surveyId, status: { in: ['started', 'abandoned', 'completed'] } } });
  await sendOwnerAlert(survey.userId, surveyId, 'milestone', String(reached), { title: survey.title, n: reached, rate: started ? Math.round((completed / started) * 1000) / 10 : 0 }, log);
}

/** Scheduler: an active survey that had answers (≥ 10 completed) and none for 48 h gets ONE slowdown alert per week. */
export async function sweepSlowdowns(now = new Date(), log: Log = noLog): Promise<number> {
  const cutoff = new Date(now.getTime() - SLOWDOWN_HOURS * 3_600_000);
  const recent = await prisma.surveyRecipient.groupBy({ by: ['surveyId'], where: { completedAt: { gte: cutoff }, status: 'completed' } });
  const surveys = await prisma.survey.findMany({ where: { status: 'active', id: { notIn: recent.map((r) => r.surveyId) }, user: { ownerPhones: { some: { alerts: true } } } }, select: { id: true, userId: true, title: true } });
  let sent = 0;
  for (const s of surveys) {
    const completed = await prisma.surveyRecipient.count({ where: { surveyId: s.id, status: 'completed' } });
    if (completed < 10) continue;
    const r = await sendOwnerAlert(s.userId, s.id, 'slowdown', isoWeek(now), { title: s.title, hours: SLOWDOWN_HOURS }, log);
    if (r === 'window' || r === 'template') sent += 1;
  }
  return sent;
}

export const countryOffset = (country: string) => COUNTRY_CONFIG[country]?.utcOffsetMinutes ?? 60;

/**
 * Submits the alert template to Meta on SurveyFlow's own WhatsApp account (once; live mode only). Meta approves it asynchronously: until then
 * an out-of-window alert is refused by Meta and logged, and in-window alerts (free replies) are unaffected.
 */
export async function ensureOwnerAlertTemplates(log: Log = noLog): Promise<number> {
  const creds = platformCreds();
  if (env.waMode !== 'live' || !creds) return 0;
  const gw = getGateway();
  const have = new Set((await gw.listTemplates(creds).catch(() => [])).map((t) => `${t.name}:${t.language}`));
  let created = 0;
  for (const def of OWNER_ALERT_DEFS) {
    if (have.has(`${def.name}:${def.language}`)) continue;
    try { await gw.createTemplate(creds, def); created += 1; } catch (err) { log.warn({ err: (err as Error).message, template: def.name }, 'owner alert template not created'); }
  }
  return created;
}
