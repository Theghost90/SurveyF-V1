import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { outboxKey } from '../src/services/whatsapp/mock';
import { buildWorld, makeApp, metaPayload, postWebhook, registerOwner, resetAll, sampleQuestions, setPlan, textMsg, type Client, type World } from './helpers';

/**
 * The Analytics Bot, end to end through the real webhook path: SurveyFlow's own number receives what an OWNER types.
 * `platform-mock` is that number's id in mock mode (see services/whatsapp/accounts.ts).
 */

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });

const PLATFORM = 'platform-mock';
const OWNER_PHONE = '237699000111';
let wamid = 0;

async function ownerSays(from: string, text: string) {
  const res = await postWebhook(app, metaPayload(PLATFORM, [textMsg(from, text, `wamid.OWN${++wamid}`)]));
  expect(res.statusCode).toBe(200);
}
async function ownerTaps(from: string, id: string) {
  const msg = { from, id: `wamid.OWNT${++wamid}`, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: id } }, timestamp: '1' };
  expect((await postWebhook(app, metaPayload(PLATFORM, [msg]))).statusCode).toBe(200);
}
/** Everything the bot said to that phone, oldest first. */
const botSaid = async (from: string) => (await redis.lrange(outboxKey(PLATFORM, from), 0, -1)).map((r) => JSON.parse(r)).filter((i) => i.direction === 'out').map((i) => i.message as { kind: string; body: string; buttons?: Array<{ id: string; title: string }>; rows?: unknown[]; url?: string });
const lastBody = async (from: string) => (await botSaid(from)).at(-1)!.body;
const clearChat = (from: string) => redis.del(outboxKey(PLATFORM, from));

async function link(o: Client, from = OWNER_PHONE) {
  const r = await o.post('/api/analytics-bot/link-code');
  expect(r.status).toBe(200);
  await ownerSays(from, `LINK ${r.code}`);
  return r.code as string;
}

/** A survey in every state: 12 invited → 3 completed, 2 abandoned at Q2, 1 in progress (at Q2), 1 declined, 1 opted out, 4 no reply. */
async function mixedWorld(over: Partial<{ plan: 'starter' | 'growth' | 'business'; contacts: number }> = {}): Promise<World> {
  const w = await buildWorld(app, { plan: over.plan ?? 'growth', contacts: over.contacts ?? 12 });
  // Invitations are paced by the sender; this test is about the numbers, so everyone still queued counts as invited now.
  await prisma.surveyRecipient.updateMany({ where: { surveyId: w.surveyId, status: 'queued' }, data: { status: 'sent', sentAt: new Date() } });
  const rec = async (i: number) => prisma.surveyRecipient.findFirstOrThrow({ where: { surveyId: w.surveyId, contactId: w.contactIds[i]! } });
  const qs = w.questions;
  const answer = (i: number, q: number) => prisma.response.create({ data: { surveyId: w.surveyId, contactId: w.contactIds[i]!, questionId: qs[q]!.id, answer: q === 2 ? 'ok' : qs[q]!.options?.[0]?.label ?? '1' } });
  const now = new Date();
  for (const i of [0, 1, 2]) { for (const q of [0, 1, 2]) await answer(i, q); await prisma.surveyRecipient.update({ where: { id: (await rec(i)).id }, data: { status: 'completed', startedAt: now, completedAt: now } }); }
  for (const i of [3, 4]) { await answer(i, 0); await prisma.surveyRecipient.update({ where: { id: (await rec(i)).id }, data: { status: 'abandoned', startedAt: now, abandonedAt: now, abandonedAtQuestion: 2 } }); }
  await answer(5, 0); await prisma.surveyRecipient.update({ where: { id: (await rec(5)).id }, data: { status: 'started', startedAt: now } });
  await prisma.surveyRecipient.update({ where: { id: (await rec(6)).id }, data: { status: 'declined' } });
  await prisma.contact.update({ where: { id: w.contactIds[7]! }, data: { optedOutAt: now } });
  return w;
}
const num = (body: string, label: string) => Number(new RegExp(`${label}: (\\d+)`).exec(body)?.[1]);

describe('who may ask: one-time linking, never the profile phone', () => {
  it('LINK <code> from a phone links it; the code works once, and a bad or expired code links nothing', async () => {
    const o = await registerOwner(app, { plan: 'growth' });
    const code = await link(o);
    expect(await prisma.ownerPhone.count({ where: { userId: o.userId } })).toBe(1);
    expect(await lastBody(OWNER_PHONE)).toMatch(/linked to Boulangerie Akwa/);

    await ownerSays('237699000222', `LINK ${code}`); // same code from another phone: already used
    expect(await prisma.ownerPhone.count()).toBe(1);
    expect(await lastBody('237699000222')).toMatch(/not valid any more/);

    await ownerSays('237699000333', 'LINK NOSUCHCODE');
    expect(await lastBody('237699000333')).toMatch(/not valid any more/);

    const second = await o.post('/api/analytics-bot/link-code');
    await redis.del(`sf:botlink:${second.code}`); // expired
    await ownerSays('237699000444', `LINK ${second.code}`);
    expect(await prisma.ownerPhone.count()).toBe(1);
  });

  it('the phone in the owner\'s profile is NOT trusted: it asks, nothing is revealed', async () => {
    const w = await mixedWorld();
    const profile = (await prisma.user.findUniqueOrThrow({ where: { id: w.owner.userId } })).phone.replace(/\D/g, '');
    await ownerSays(profile, 'STATS');
    const said = await botSaid(profile);
    expect(said).toHaveLength(1);
    expect(said[0]!.body).toMatch(/not linked to a SurveyFlow account/);
    expect(said[0]!.body).not.toMatch(/Customer Satisfaction/);
    await ownerSays(profile, 'STATS');
    expect(await botSaid(profile)).toHaveLength(1); // a stranger gets one answer, not an echo
  });

  it('a phone belongs to ONE account, an account holds at most 3 phones, and UNLINK (or the SaaS) removes one', async () => {
    const a = await registerOwner(app, { plan: 'growth' });
    const b = await registerOwner(app, { plan: 'growth' });
    await link(a);
    await link(b); // same phone, other account
    expect(await lastBody(OWNER_PHONE)).toMatch(/linked to another SurveyFlow account/);
    expect(await prisma.ownerPhone.count({ where: { userId: b.userId } })).toBe(0);

    for (const p of ['237699000201', '237699000202']) await link(a, p);
    expect(await prisma.ownerPhone.count({ where: { userId: a.userId } })).toBe(3);
    const full = await a.raw('POST', '/api/analytics-bot/link-code');
    expect(full.status).toBe(409);
    expect(full.json.error).toBe('link_limit');

    await ownerSays('237699000201', 'UNLINK');
    expect(await prisma.ownerPhone.count({ where: { userId: a.userId } })).toBe(2);
    const status = await a.get('/api/analytics-bot');
    expect(status.phones).toHaveLength(2);
    expect(status.phones[0].phone).toMatch(/\+237 6XX XXX \d{3}/); // masked even in the SaaS list
    expect((await a.del(`/api/analytics-bot/phones/${status.phones[0].id}`)).status).toBe(204);
    expect(await prisma.ownerPhone.count({ where: { userId: a.userId } })).toBe(1);
  });
});

describe('who gets the bot: Starter, Growth and Business', () => {
  it('Explore cannot create a code, and a plan that ends stops the bot answering with numbers', async () => {
    const o = await registerOwner(app);
    const r = await o.raw('POST', '/api/analytics-bot/link-code');
    expect(r.status).toBe(402);
    expect(r.json.error).toBe('plan_feature');
    expect((await o.get('/api/analytics-bot')).included).toBe(false);
  });

  it.each(['starter', 'growth', 'business'] as const)('%s: linked and answering', async (plan) => {
    const w = await mixedWorld({ plan });
    await link(w.owner);
    await ownerSays(OWNER_PHONE, 'STATS');
    expect(await lastBody(OWNER_PHONE)).toMatch(/Invitations sent: 12/);
  });

  it('downgraded to Explore after linking: the phone stays linked but gets the plan notice, never numbers', async () => {
    const w = await mixedWorld();
    await link(w.owner);
    await setPlan(w.owner.userId, 'trial');
    await clearChat(OWNER_PHONE);
    await ownerSays(OWNER_PHONE, 'STATS');
    const said = await botSaid(OWNER_PHONE);
    expect(said).toHaveLength(1);
    expect(said[0]!.body).toMatch(/Starter, Growth and Business/);
    expect(said[0]!.body).not.toMatch(/Invitations/);
  });

  it('linking on Explore (plan changed between code and link) says so and keeps the code for after activating', async () => {
    const o = await registerOwner(app, { plan: 'growth' });
    const r = await o.post('/api/analytics-bot/link-code');
    await setPlan(o.userId, 'trial');
    await ownerSays(OWNER_PHONE, `LINK ${r.code}`);
    expect(await lastBody(OWNER_PHONE)).toMatch(/Starter, Growth and Business/);
    expect(await prisma.ownerPhone.count()).toBe(0);
    await setPlan(o.userId, 'starter');
    await ownerSays(OWNER_PHONE, `LINK ${r.code}`);
    expect(await prisma.ownerPhone.count()).toBe(1);
  });
});

describe('the numbers add up, and match the dashboard', () => {
  it('STATS: started = completed + in progress + abandoned, sent = started + no reply + declined + opted out — and every number equals the dashboard\'s', async () => {
    const w = await mixedWorld();
    await link(w.owner);
    await ownerSays(OWNER_PHONE, 'STATS');
    const body = await lastBody(OWNER_PHONE);
    const dash = (await w.owner.get(`/api/surveys/${w.surveyId}/analytics`)).totals;
    expect(dash).toMatchObject({ sent: 12, started: 6, completed: 3, abandoned: 2, inProgress: 1, noReply: 4, declined: 1, optedOut: 1 });
    expect(num(body, 'Invitations sent')).toBe(dash.sent);
    expect(num(body, 'Started')).toBe(dash.started);
    expect(num(body, 'Completed')).toBe(dash.completed);
    expect(num(body, 'In progress')).toBe(dash.inProgress);
    expect(num(body, 'Abandoned')).toBe(dash.abandoned);
    expect(num(body, 'No reply')).toBe(dash.noReply);
    expect(num(body, 'Declined')).toBe(dash.declined);
    expect(num(body, 'Opted out \\(never contacted again\\)')).toBe(dash.optedOut);
    expect(dash.started).toBe(dash.completed + dash.inProgress + dash.abandoned);
    expect(dash.sent).toBe(dash.started + dash.noReply + dash.declined + dash.optedOut);
    expect(body).toContain('Completion rate: 50% (completed ÷ started)');
    expect(body).toMatch(/as of \d\d:\d\d/);
    expect(body).toContain('Customer Satisfaction'); // every reply names its survey
  });

  it('a STOP contact is no longer "no reply" — not in the count, not in the dashboard list, not in the bot list', async () => {
    const w = await mixedWorld();
    const stopped = await prisma.contact.findUniqueOrThrow({ where: { id: w.contactIds[7]! } });
    const a = await w.owner.get(`/api/surveys/${w.surveyId}/analytics`);
    expect(a.totals.noReply).toBe(4);
    expect(a.nonStarters.map((n: { name: string }) => n.name)).not.toContain(stopped.name);
    await link(w.owner);
    await ownerSays(OWNER_PHONE, 'NONRESP');
    const body = (await botSaid(OWNER_PHONE)).map((m) => m.body).join('\n');
    expect(body).toContain("Haven't replied: 4");
    expect(body).not.toContain(stopped.name);
  });

  it('DROP: only confirmed abandons per question (they add up to the abandoned total), people still in progress shown apart', async () => {
    const w = await mixedWorld();
    await link(w.owner);
    await ownerSays(OWNER_PHONE, 'DROP');
    const body = await lastBody(OWNER_PHONE);
    const stops = [...body.matchAll(/→ (\d+) got past it · (\d+) stopped here/g)].map((m) => ({ passed: Number(m[1]), stopped: Number(m[2]) }));
    expect(stops).toHaveLength(3);
    expect(stops[1]!.stopped).toBe(2);
    expect(stops.reduce((a, s) => a + s.stopped, 0)).toBe(2); // = the dashboard's abandoned
    expect(body).toContain('1 still in progress: not counted as dropped until 24 h of silence');
    expect(body).toContain('Highest dropoff at Q2');
    await clearChat(OWNER_PHONE);
    await ownerSays(OWNER_PHONE, 'PERQ'); // kept as an alias
    expect(await lastBody(OWNER_PHONE)).toContain('Where people stop');
  });

  it('the advice follows one rule: required → make optional; already optional → shorter/clearer; a long list → fewer options (dashboard and bot alike)', async () => {
    const mk = async (required: boolean, type: 'text' | 'list', options = 3) => {
      const w = await buildWorld(app, {
        plan: 'growth', contacts: 3,
        questions: [{ text: 'Tell us more', type, required, options: type === 'list' ? Array.from({ length: options }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })) : null }],
      });
      const recip = await prisma.surveyRecipient.findFirstOrThrow({ where: { surveyId: w.surveyId } });
      await prisma.surveyRecipient.update({ where: { id: recip.id }, data: { status: 'abandoned', startedAt: new Date(), abandonedAt: new Date(), abandonedAtQuestion: 1 } });
      return (await w.owner.get(`/api/surveys/${w.surveyId}/analytics`)).dropOff.suggestion as string;
    };
    expect(await mk(true, 'text')).toBe('make_optional');
    await resetAll();
    expect(await mk(false, 'text')).toBe('shorten'); // was "make optional" for a question that already is
    await resetAll();
    expect(await mk(true, 'list', 8)).toBe('simplify_options');
  });
});

describe('which survey, how it is asked', () => {
  async function twoSurveys() {
    const w = await mixedWorld();
    const s2 = await w.owner.post('/api/surveys', { title: 'Second survey', language: 'en', questions: sampleQuestions() });
    await prisma.survey.update({ where: { id: w.surveyId }, data: { status: 'paused' } }); // frees the single... growth allows 15, but order must prefer ACTIVE
    await w.owner.post(`/api/surveys/${s2.id}/publish`);
    await prisma.survey.update({ where: { id: w.surveyId }, data: { status: 'active', publishedAt: new Date(Date.now() - 86_400_000) } });
    return { w, second: s2.id as string };
  }

  it('defaults to the most recently published active survey; SURVEYS lists them; STATS 2 picks the other; every card names it', async () => {
    const { w } = await twoSurveys();
    await link(w.owner);
    await ownerSays(OWNER_PHONE, 'STATS');
    expect(await lastBody(OWNER_PHONE)).toContain('Second survey');
    await ownerSays(OWNER_PHONE, 'SURVEYS');
    const list = await lastBody(OWNER_PHONE);
    expect(list).toMatch(/1\. Second survey · active · 0\/0/);
    expect(list).toMatch(/2\. Customer Satisfaction · active · 3\/12/);
    await ownerSays(OWNER_PHONE, 'STATS 2');
    expect(await lastBody(OWNER_PHONE)).toContain('Customer Satisfaction');
    await ownerSays(OWNER_PHONE, 'STATS 9');
    expect(await lastBody(OWNER_PHONE)).toMatch(/no survey 9/);
  });

  it('an owner never sees another owner\'s survey', async () => {
    const other = await mixedWorld();
    const mine = await registerOwner(app, { plan: 'growth' });
    await link(mine);
    await ownerSays(OWNER_PHONE, 'STATS');
    expect(await lastBody(OWNER_PHONE)).toMatch(/no survey with invitations sent yet/);
    expect(other.surveyId).toBeTruthy();
  });

  it('French or English, any case, with or without accents; replies in the owner\'s language; chips are tappable', async () => {
    const w = await mixedWorld();
    await prisma.user.update({ where: { id: w.owner.userId }, data: { locale: 'fr' } });
    await link(w.owner);
    for (const [word, expect_] of [['Statistiques', /Invitations envoyées: 12/], ['ABANDONS', /Où les gens s’arrêtent/], ['sans réponse', /N’ont pas répondu: 4/], ['  aide ', /SurveyFlow Analytics/], ['TERMINÉS', /Terminé: 3/], ['stats', /Taux de complétion/]] as const) {
      await clearChat(OWNER_PHONE);
      await ownerSays(OWNER_PHONE, word);
      expect((await botSaid(OWNER_PHONE)).map((m) => m.body).join('\n'), word).toMatch(expect_);
    }
    await clearChat(OWNER_PHONE);
    await ownerTaps(OWNER_PHONE, 'ab:DROP'); // a tapped chip = the typed word
    expect(await lastBody(OWNER_PHONE)).toMatch(/Où les gens s’arrêtent/);
    await ownerSays(OWNER_PHONE, 'bonjour tout le monde');
    expect(await lastBody(OWNER_PHONE)).toMatch(/Envoyez AIDE/);
  });

  it('too many commands: one polite stop, then silence, per owner', async () => {
    const w = await mixedWorld();
    await link(w.owner);
    for (let i = 0; i < 24; i++) await ownerSays(OWNER_PHONE, 'HELP');
    const said = await botSaid(OWNER_PHONE);
    expect(said.filter((m) => /asking too fast/.test(m.body))).toHaveLength(1);
    expect(said.filter((m) => m.kind === 'list')).toHaveLength(20);
  });
});

describe('lists: names with MASKED numbers on WhatsApp, full numbers only in SurveyFlow', () => {
  it('NONRESP / STARTED / COMPLETED: masked numbers, 10 at a time, MORE continues, STARTED says where they stopped', async () => {
    const w = await mixedWorld({ contacts: 30 });
    await link(w.owner);
    const full = (await prisma.contact.findMany({ where: { userId: w.owner.userId } })).map((c) => c.phone.replace('+', ''));

    const noReply = (await w.owner.get(`/api/surveys/${w.surveyId}/analytics`)).totals.noReply as number;
    expect(noReply).toBeGreaterThan(20); // enough people to need three pages
    await clearChat(OWNER_PHONE);
    await ownerSays(OWNER_PHONE, 'NONRESP');
    const first = await botSaid(OWNER_PHONE);
    expect(first[0]!.body).toContain(`Haven't replied: ${noReply} · showing 1–10`);
    expect(first[0]!.body).toMatch(/1\. Contact \d+ · \+237 6XX XXX \d{3}/);
    expect(first[0]!.body.split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(10);
    expect(first[0]!.body).toContain('MORE for the next 10');
    expect(first[1]).toMatchObject({ kind: 'link', buttonLabel: 'Open in SurveyFlow' }); // the full list lives there
    expect(first[1]!.url).toMatch(/\/surveys\/.+\/analytics#not-started$/);
    for (const m of first) for (const p of full) expect(m.body).not.toContain(p); // no complete number, ever

    await clearChat(OWNER_PHONE);
    await ownerSays(OWNER_PHONE, 'MORE');
    expect((await botSaid(OWNER_PHONE))[0]!.body).toMatch(/showing 11–20/);
    await clearChat(OWNER_PHONE);
    await ownerSays(OWNER_PHONE, 'more');
    expect((await botSaid(OWNER_PHONE))[0]!.body).toContain(`showing 21–${noReply}`);

    await clearChat(OWNER_PHONE);
    await ownerSays(OWNER_PHONE, 'STARTED');
    const started = (await botSaid(OWNER_PHONE))[0]!.body;
    expect(started).toContain('Started, not finished: 3'); // 2 abandoned + 1 in progress; the 3 who completed are NOT here
    expect(started).toContain('stopped at Q2');
    expect(started).toContain('at Q2 now');
    await clearChat(OWNER_PHONE);
    await ownerSays(OWNER_PHONE, 'COMPLETED');
    expect((await botSaid(OWNER_PHONE))[0]!.body).toContain('Completed: 3');
    await clearChat(OWNER_PHONE);
    await ownerSays(OWNER_PHONE, 'ALL NONRESP');
    const all = await botSaid(OWNER_PHONE);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: 'link' }); // the old "export to your SaaS" answer is now a real button
  });

  it('MORE without a list before it says so', async () => {
    const w = await mixedWorld();
    await link(w.owner);
    await ownerSays(OWNER_PHONE, 'MORE');
    expect(await lastBody(OWNER_PHONE)).toMatch(/no list to continue/);
  });

  it('the SaaS list has the COMPLETE numbers, is paged, excludes STOP, and its CSV defuses spreadsheet formulas', async () => {
    const w = await mixedWorld();
    await prisma.contact.update({ where: { id: w.contactIds[8]! }, data: { name: '=HYPERLINK("http://evil","click")' } });
    const page = await w.owner.get(`/api/surveys/${w.surveyId}/not-started?pageSize=2&page=1`);
    expect(page.total).toBe(4);
    expect(page.items).toHaveLength(2);
    expect(page.items[0].phone).toMatch(/^\+2376771000\d\d$/); // complete, not masked
    const all = await w.owner.get(`/api/surveys/${w.surveyId}/not-started?pageSize=100`);
    expect(all.items.map((i: { name: string }) => i.name)).not.toContain('Contact 8'); // contact index 7 = STOP
    const csv = await w.owner.raw('GET', `/api/surveys/${w.surveyId}/not-started.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const text = csv.rawBody.toString('utf8');
    expect(text.startsWith('\uFEFFname,phone')).toBe(true);
    expect(text).toContain('"+2376771000');
    expect(text).toContain(`"'=HYPERLINK(`); // leading = defused
    expect(text).not.toContain(`"=HYPERLINK`);
    expect(text).not.toContain(`"'+237`); // a phone is not a formula
    const other = await registerOwner(app, { plan: 'growth' });
    expect((await other.raw('GET', `/api/surveys/${w.surveyId}/not-started`)).status).toBe(404);
  });
});
