import { randomInt } from 'node:crypto';
import {
  COUNTRY_CONFIG, asOfLabel, botBadIndex, botDropMessage, botMuted, botResultsMessages, botHelpMessage, botLinked, botListMessages, botNotice, botOpenSaasMessage, botStartedNote, botStatsMessage,
  botSurveysMessage, getPlan, maskPhone, parseBotButtonId, parseBotCommand, toBotStats, type BotCommand, type BotListKind, type BotLocale, type OutboundMessage, type ParsedCommand,
} from '@surveyflow/shared';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { computeAnalytics, listRecipientsByKind } from './analytics';
import { platformCreds } from './whatsapp/accounts';
import { getGateway } from './whatsapp/gateway';
import type { WaInboundMessage } from './survey/handler';

/**
 * Analytics Bot. The owner asks SurveyFlow's own WhatsApp number for numbers; this is the whole server side.
 *
 *  - WHO: only a phone that proved it belongs to the owner. In SurveyFlow (Settings → Analytics on WhatsApp) the owner gets a one-time code
 *    that works for 15 minutes; sending `LINK <code>` from the phone links it. The phone number in the profile is never trusted: it is not
 *    verified anywhere, and SIMs get recycled, so participants' names and numbers could otherwise go to a stranger. UNLINK works any time.
 *  - WHICH SURVEY: the most recently published active one; SURVEYS lists them, `STATS 2` picks the second. Every card names its survey.
 *  - WHAT: the cards of shared/analytics-bot.ts (the builder preview prints the same ones), computed by the SAME computeAnalytics the
 *    dashboard uses, with an "as of" time. WhatsApp shows names + MASKED numbers; complete numbers stay inside SurveyFlow.
 *  - WHO PAYS: nothing. Every reply is inside the 24-hour window the owner just opened by writing.
 */

const CODE_TTL_S = 15 * 60;
export const MAX_LINKED_PHONES = 3;
const RATE = { max: 20, windowS: 10 * 60 };
const PAGE = 10;
const MAX_SURVEYS = 10;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L: read aloud and typed from a screen

const codeKey = (code: string) => `sf:botlink:${code}`;
const userCodeKey = (userId: string) => `sf:botlink:user:${userId}`;
const listKey = (userId: string) => `sf:bot:list:${userId}`;

/** SurveyFlow's number as people dial it (env), or a fixed demo one in mock mode. Null = the bot is not available on this deployment. */
export const platformPhone = (): string | null => env.WHATSAPP_PLATFORM_PHONE ?? (env.waMode === 'mock' ? '237600000001' : null);
export const isPlatformNumber = (phoneNumberId: string): boolean => platformCreds()?.phoneNumberId === phoneNumberId;

// ---- linking (called by the SaaS) ------------------------------------------------------------------------------------------------

export async function createLinkCode(userId: string): Promise<{ code: string; expiresAt: Date; waLink: string }> {
  const phone = platformPhone();
  if (!phone) throw new Error('analytics bot unavailable: no platform number');
  const old = await redis.get(userCodeKey(userId));
  if (old) await redis.del(codeKey(old)); // one live code per owner
  const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!).join('');
  await redis.multi().set(codeKey(code), userId, 'EX', CODE_TTL_S).set(userCodeKey(userId), code, 'EX', CODE_TTL_S).exec();
  return { code, expiresAt: new Date(Date.now() + CODE_TTL_S * 1000), waLink: `https://wa.me/${phone}?text=${encodeURIComponent(`LINK ${code}`)}` };
}

export async function linkedPhones(userId: string) {
  const rows = await prisma.ownerPhone.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => ({ id: r.id, phone: maskPhone(`+${r.phone}`), alerts: r.alerts, createdAt: r.createdAt }));
}

export async function unlinkPhoneById(userId: string, id: string): Promise<boolean> {
  return (await prisma.ownerPhone.deleteMany({ where: { id, userId } })).count > 0;
}

// ---- inbound -----------------------------------------------------------------------------------------------------------------------

async function send(to: string, messages: OutboundMessage[], log: { warn: (o: unknown, m?: string) => void }) {
  const creds = platformCreds();
  if (!creds) return;
  for (const m of messages) {
    try { await getGateway().sendMessage(creds, to, m); } catch (err) { log.warn({ err: (err as Error).message }, 'analytics bot reply failed'); }
  }
}

/** True the first time within `ttlS`: used so a stranger (or a flood) gets at most one answer. */
const once = async (key: string, ttlS: number) => (await redis.set(key, '1', 'EX', ttlS, 'NX')) === 'OK';

function readInput(msg: WaInboundMessage): { cmd?: BotCommand; text: string } {
  // a tapped quick reply of the alert template arrives as a `button` message whose payload is the same id
  const id = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id ?? (msg.type === 'button' ? msg.button?.payload : undefined);
  if (id) { const c = parseBotButtonId(id); if (c) return { cmd: c, text: '' }; }
  return { text: msg.type === 'text' ? (msg.text?.body ?? '') : '' };
}

/** Before an owner is known there is no language setting: follow the word they used. */
const guessLocale = (text: string): BotLocale => (/^\s*(lier|delier|aide|sondages?|stat|statistiques|resume|résumé|bilan|abandons?)\b/i.test(text) ? 'fr' : /^\s*(link|help|stats|drop|surveys?)\b/i.test(text) ? 'en' : 'fr');

export async function handleOwnerMessage(msg: WaInboundMessage, log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void }): Promise<void> {
  const from = msg.from;
  const input = readInput(msg);
  const parsed: ParsedCommand | null = input.cmd ? { command: input.cmd } : parseBotCommand(input.text);

  if (parsed?.command === 'link') return doLink(from, parsed.code ?? '', input.text, log);

  const link = await prisma.ownerPhone.findUnique({ where: { phone: from }, include: { user: { select: { id: true, locale: true, businessName: true, plan: true, country: true } } } });
  if (!link) {
    if (await once(`sf:bot:stranger:${from}`, 3600)) await send(from, [botNotice('notLinked', guessLocale(input.text))], log);
    return;
  }
  const { user } = link;
  await prisma.ownerPhone.update({ where: { id: link.id }, data: { lastInboundAt: new Date() } }); // opens the 24 h window in which alerts are free
  const locale: BotLocale = user.locale === 'en' ? 'en' : 'fr';

  if (parsed?.command === 'unlink') {
    await prisma.ownerPhone.delete({ where: { id: link.id } });
    return send(from, [botNotice('unlinked', locale)], log);
  }
  if (parsed?.command === 'mute' || parsed?.command === 'unmute') {
    await prisma.ownerPhone.update({ where: { id: link.id }, data: { alerts: parsed.command === 'unmute' } });
    return send(from, [botMuted(parsed.command === 'unmute', locale)], log);
  }
  if (!getPlan(user.plan).features.analyticsBot) return send(from, [botNotice('locked', locale)], log);

  const n = await redis.incr(`sf:bot:rate:${user.id}`);
  if (n === 1) await redis.expire(`sf:bot:rate:${user.id}`, RATE.windowS);
  if (n > RATE.max) {
    if (n === RATE.max + 1) await send(from, [botNotice('rate', locale)], log);
    return;
  }
  if (!parsed) return send(from, [botNotice('unknown', locale)], log);

  const asOf = asOfLabel(new Date(), COUNTRY_CONFIG[user.country]?.utcOffsetMinutes ?? 60);
  const web = env.webOrigins[0] ?? '';

  if (parsed.command === 'help') return send(from, [botHelpMessage(locale)], log);

  const surveys = await ownerSurveys(user.id);
  if (parsed.command === 'surveys') {
    if (!surveys.length) return send(from, [botNotice('noSurvey', locale)], log);
    return send(from, [botSurveysMessage(surveys, locale, asOf)], log);
  }

  // `MORE` continues the last list of the same owner
  if (parsed.command === 'more') {
    const raw = await redis.get(listKey(user.id));
    if (!raw) return send(from, [botNotice('noList', locale)], log);
    const st = JSON.parse(raw) as { kind: BotListKind; surveyId: string; offset: number };
    const s = surveys.find((x) => x.id === st.surveyId);
    if (!s) return send(from, [botNotice('noList', locale)], log);
    return send(from, await listPage(user.id, s, st.kind, st.offset, locale, asOf, web), log);
  }

  if (!surveys.length) return send(from, [botNotice('noSurvey', locale)], log);
  const survey = parsed.surveyIndex ? surveys[parsed.surveyIndex - 1] : surveys[0];
  if (!survey) return send(from, [botBadIndex(parsed.surveyIndex!, locale)], log);

  switch (parsed.command) {
    case 'stats': return send(from, [botStatsMessage(toBotStats(await computeAnalytics(survey.id, user.id)), locale, asOf)], log);
    case 'results': return send(from, botResultsMessages(toBotStats(await computeAnalytics(survey.id, user.id)), locale, asOf, web ? `${web}/surveys/${survey.id}/analytics` : null), log);
    case 'drop': return send(from, [botDropMessage(toBotStats(await computeAnalytics(survey.id, user.id)), locale, asOf)], log);
    case 'nonresp':
      // "ALL NONRESP" (the design's export) lives in SurveyFlow now: the full list, with every number, and a CSV
      if (parsed.all) return send(from, [botOpenSaasMessage(locale, notStartedUrl(web, survey.id))], log);
      return send(from, await listPage(user.id, survey, 'nonresp', 0, locale, asOf, web), log);
    case 'started': return send(from, await listPage(user.id, survey, 'started', 0, locale, asOf, web), log);
    case 'completed': return send(from, await listPage(user.id, survey, 'completed', 0, locale, asOf, web), log);
    default: return send(from, [botNotice('unknown', locale)], log);
  }
}

const notStartedUrl = (web: string, surveyId: string) => `${web}/surveys/${surveyId}/analytics#not-started`;

/** The owner's surveys that have been published, most recently active first: SURVEYS shows them in this order and `STATS 2` means the second. */
async function ownerSurveys(userId: string) {
  const rows = await prisma.survey.findMany({
    where: { userId, status: { in: ['active', 'paused', 'closed'] } },
    select: { id: true, title: true, status: true, publishedAt: true, createdAt: true },
  });
  const rank = (s: { status: string }) => (s.status === 'active' ? 0 : s.status === 'paused' ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || (b.publishedAt ?? b.createdAt).getTime() - (a.publishedAt ?? a.createdAt).getTime());
  const top = rows.slice(0, MAX_SURVEYS);
  const groups = await prisma.surveyRecipient.groupBy({ by: ['surveyId', 'status'], where: { surveyId: { in: top.map((s) => s.id) } }, _count: { _all: true } });
  return top.map((s) => {
    const mine = groups.filter((g) => g.surveyId === s.id);
    const sum = (f: (st: string) => boolean) => mine.filter((g) => f(g.status)).reduce((a, g) => a + g._count._all, 0);
    return { id: s.id, title: s.title, status: s.status, sent: sum((st) => !['queued', 'failed'].includes(st)), completed: sum((st) => st === 'completed') };
  });
}

async function listPage(userId: string, survey: { id: string; title: string }, kind: BotListKind, offset: number, locale: BotLocale, asOf: string, web: string): Promise<OutboundMessage[]> {
  const { total, rows } = await listRecipientsByKind(survey.id, userId, kind, { skip: offset, take: PAGE });
  await redis.set(listKey(userId), JSON.stringify({ kind, surveyId: survey.id, offset: offset + PAGE }), 'EX', 1800);
  return botListMessages(kind, survey.title, rows.map((r) => ({ name: r.name, phone: maskPhone(r.phone), note: kind === 'started' ? botStartedNote(r.status, r.atQuestion, locale) : undefined })), total, offset, locale, asOf, web ? notStartedUrl(web, survey.id) : null);
}

async function doLink(from: string, code: string, text: string, log: { warn: (o: unknown, m?: string) => void }) {
  const locale = guessLocale(text);
  const userId = code ? await redis.get(codeKey(code)) : null;
  if (!userId) return send(from, [botNotice('linkBad', locale)], log);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, locale: true, businessName: true, plan: true } });
  if (!user) return send(from, [botNotice('linkBad', locale)], log);
  const own: BotLocale = user.locale === 'en' ? 'en' : 'fr';
  // Not part of this plan: say so and keep the code, so activating a plan and trying again within the window works.
  if (!getPlan(user.plan).features.analyticsBot) return send(from, [botNotice('locked', own)], log);
  const existing = await prisma.ownerPhone.findUnique({ where: { phone: from } });
  if (existing && existing.userId !== user.id) return send(from, [botNotice('linkTaken', own)], log);
  if (!existing && (await prisma.ownerPhone.count({ where: { userId: user.id } })) >= MAX_LINKED_PHONES) return send(from, [botNotice('linkLimit', own)], log);
  // single use: whoever deletes the code first wins
  if ((await redis.del(codeKey(code))) !== 1) return send(from, [botNotice('linkBad', locale)], log);
  await redis.del(userCodeKey(user.id));
  if (!existing) await prisma.ownerPhone.create({ data: { userId: user.id, phone: from } });
  await send(from, [botLinked(user.businessName, own)], log);
}

