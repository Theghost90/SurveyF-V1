import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { GiftError, setGiftProvider } from '../src/services/gifts/providers';
import { processDueGifts } from '../src/services/gifts';
import { buildReceiptHtml, giftIdFromToken, loadReceipt, receiptToken, receiptUrl } from '../src/services/receipts';
import { runSendWorkerOnce } from '../src/services/whatsapp/sender';
import { answerIdFor, buildWorld, chatOf, client, makeApp, registerOwner, replyMsg, resetAll, say, templateBtn, textMsg, type World, connectMockWhatsApp, registerFrom } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { setGiftProvider(null); await resetAll(); });

// ---- geography ---------------------------------------------------------------------------------------------

async function register(country: string | undefined, over: Record<string, unknown> = {}) {
  const r = await registerFrom(app, country, over);
  if (r.status === 200) await connectMockWhatsApp(r.body.user.id);
  return r;
}
const meWith = (c: ReturnType<typeof client>, country?: string) =>
  app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${c.token}`, ...(country ? { 'x-sf-country': country } : {}) } }).then((r) => JSON.parse(r.body));

describe('country and currency follow the visitor', () => {
  it('registration uses the detected country: its currency, and its phone format for local numbers', async () => {
    const ng = await register('NG', { phone: '0803 123 4567' });
    expect(ng.status).toBe(200);
    expect(ng.body.user).toMatchObject({ country: 'NG', preferredCurrency: 'NGN', phone: '+2348031234567' });
    const ci = await register('CI', { phone: '07 12 34 56 78' });
    expect(ci.body.user).toMatchObject({ country: 'CI', preferredCurrency: 'XOF', phone: '+2250712345678' });
  });

  it('defaults to Cameroon / FCFA when the country is unknown or unsupported (the form no longer sends one)', async () => {
    expect((await register(undefined)).body.user).toMatchObject({ country: 'CM', preferredCurrency: 'XAF', phone: '+237677123456' });
    expect((await register('US')).body.user).toMatchObject({ country: 'CM', preferredCurrency: 'XAF' });
    expect((await register('zz')).body.user).toMatchObject({ country: 'CM' });
  });

  it('prices for a Nigerian owner come back in naira, converted from the FCFA prices at the live rate', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ result: 'success', base_code: 'XAF', time_last_update_unix: Math.floor(Date.now() / 1000), rates: { NGN: 2.4 } }) }) as Response);
    try {
      const { c } = await register('NG', { phone: '0803 123 4567' });
      const sub = await c.get('/api/subscription');
      expect(sub.currency).toBe('NGN');
      expect(sub.prices.growth).toMatchObject({ monthly: 93_600, annual: 1_030_000, currency: 'NGN' }); // 39,000 × 2.4; a year is 11 months
      expect(sub.methods).toEqual(['card']); // no Mobile Money in naira
    } finally { vi.unstubAllGlobals(); }
  });

  it('follows the owner\'s location until the FIRST payment, then locks (a paying customer\'s price must not move)', async () => {
    const { c, body } = await register('CM');
    expect((await meWith(c, 'CI')).user).toMatchObject({ country: 'CI', preferredCurrency: 'XOF' }); // trial: follows
    expect((await meWith(c)).user.country).toBe('CI'); // no header = unknown: never overwritten with a guess
    expect((await meWith(c, 'GA')).user).toMatchObject({ country: 'GA', preferredCurrency: 'XAF' });

    const init = await c.post('/api/payments/initiate', { plan: 'starter', interval: 'monthly', method: 'mobile_money', phone: '+241061234567' });
    expect(init.status).toBe(201);
    await c.post(`/api/payments/mock/${init.reference}`, { outcome: 'success' });

    expect((await meWith(c, 'NG')).user).toMatchObject({ country: 'GA', preferredCurrency: 'XAF' }); // locked
    expect((await prisma.user.findUniqueOrThrow({ where: { id: body.user.id } })).country).toBe('GA');
  });
});

describe('profile: no country, currency or payment provider to choose; segment is chosen', () => {
  it('ignores country / preferredPSP / currency sent by a client, accepts a segment, rejects nonsense', async () => {
    const { c } = await register('CM');
    const r = await c.raw('PATCH', '/api/auth/me', { name: 'Ada B', country: 'KE', preferredPSP: 'flutterwave', preferredCurrency: 'USD', segment: 'academic' });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ name: 'Ada B', country: 'CM', preferredCurrency: 'XAF', segment: 'academic' });
    expect(r.json.user).not.toHaveProperty('preferredPSP');
    expect((await c.raw('PATCH', '/api/auth/me', { segment: 'pirate' })).status).toBe(400);
  });

  it('the account summary says whether the segment was chosen (the onboarding step gates on it)', async () => {
    const { c } = await register('CM');
    expect((await c.get('/api/auth/me')).onboarding.segmentChosen).toBe(false);
    await c.raw('PATCH', '/api/auth/me', { segment: 'institution' });
    const me = await c.get('/api/auth/me');
    expect(me.onboarding.segmentChosen).toBe(true);
    expect(me.user.segment).toBe('institution');
  });

  it('setup cannot be marked done without a segment — and can once one is chosen', async () => {
    const { c } = await register('CM');
    const refused = await c.raw('PATCH', '/api/auth/me', { onboardingDone: true });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe('segment_required');
    expect((await c.get('/api/auth/me')).onboarding.done).toBe(false);
    expect((await c.raw('PATCH', '/api/auth/me', { onboardingDone: true, segment: 'business' })).status).toBe(200);
    expect((await c.get('/api/auth/me')).onboarding.done).toBe(true);
  });

  it('phone errors show an example from the OWNER\'s country', async () => {
    const { c } = await register('NG', { phone: '0803 123 4567' });
    const bad = await c.raw('PATCH', '/api/auth/me', { phone: '1234567' });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toContain('+234 803 123 4567');
  });

  it('a new phone number is normalised with the OWNER\'s country, not Cameroon', async () => {
    const { c } = await register('KE', { phone: '0712 345 678' });
    expect((await c.raw('PATCH', '/api/auth/me', { phone: '0722 000 111' })).json.user.phone).toBe('+254722000111');
  });
});

// ---- receipts ----------------------------------------------------------------------------------------------

const airtime = { giftType: 'airtime', giftValue: '500 FCFA airtime', giftAmount: 500, giftDeliveryMode: 'immediate' };

async function complete(w: World, idx: number) {
  const [q1, q2] = w.questions;
  await say(app, w, idx, (f) => templateBtn(f, `START:${w.surveyId}`));
  await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q1!, 0), 'button_reply'));
  await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q2!, 0), 'list_reply'));
  await say(app, w, idx, (f) => textMsg(f, 'done'));
}
const giftOf = (w: World, i: number) => prisma.giftDelivery.findFirstOrThrow({ where: { surveyId: w.surveyId, contactId: w.contactIds[i]! } });
const get = (url: string) => app.inject({ method: 'GET', url });
const pathOf = (url: string) => new URL(url).pathname;

describe('proof of gift (receipt)', () => {
  it('exists only after the gift was DELIVERED: link in the WhatsApp message, in the owner\'s list, and a real PDF behind it', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime, wallet: 10_000 });
    await complete(w, 0);
    const g = await giftOf(w, 0);

    // before delivery: no link anywhere, and the endpoint refuses the (validly signed) token
    expect((await w.owner.get(`/api/surveys/${w.surveyId}/gifts`)).items[0].receiptUrl).toBeNull();
    expect((await get(pathOf(receiptUrl(g.id)))).statusCode).toBe(404);

    await processDueGifts();
    const list = (await w.owner.get(`/api/surveys/${w.surveyId}/gifts`)).items[0];
    expect(list.status).toBe('sent');
    expect(list.receiptUrl).toBe(receiptUrl(g.id));
    // inside the 24 h window: a short message with a "Download receipt" BUTTON (same look as the template path), never a raw URL in the text
    const sentNotice = (await chatOf(0)).at(-1).message;
    expect(sentNotice).toMatchObject({ kind: 'link', buttonLabel: 'Download receipt', url: receiptUrl(g.id) });
    expect(sentNotice.body).toMatch(/has been sent/);
    expect(sentNotice.body).not.toContain('/api/receipts/');

    const res = await get(pathOf(list.receiptUrl)); // no Authorization header: the participant has no account
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="receipt-SF-[A-Z0-9]{8}\.pdf"/);
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  }, 60_000);

  it('a gift that FAILED never gets a receipt (and the owner\'s list shows no link)', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime, wallet: 10_000 });
    await complete(w, 0);
    setGiftProvider({ name: 'declining', sendMoMo: async () => ({ providerRef: 'x' }), sendAirtime: async () => { throw new GiftError('number not eligible', false); } });
    for (let i = 0; i < 3; i++) { await processDueGifts(); await prisma.giftDelivery.updateMany({ where: { status: 'pending' }, data: { scheduledFor: new Date() } }); }
    const g = await giftOf(w, 0);
    expect(g.status).toBe('failed');
    expect((await w.owner.get(`/api/surveys/${w.surveyId}/gifts`)).items[0].receiptUrl).toBeNull();
    expect((await get(pathOf(receiptUrl(g.id)))).statusCode).toBe(404);
    expect(JSON.stringify(await chatOf(0))).not.toContain('/api/receipts/');
  });

  it('forged, tampered and unrelated tokens all get the same 404', async () => {
    const w = await buildWorld(app, { plan: 'growth', contacts: 2, gift: airtime, wallet: 10_000 });
    await complete(w, 0);
    await complete(w, 1);
    await processDueGifts();
    const [a, b] = [await giftOf(w, 0), await giftOf(w, 1)];
    const good = receiptToken(a.id);
    expect((await get(`/api/receipts/${good}`)).statusCode).toBe(200);
    expect((await get(`/api/receipts/${good.slice(0, -2)}xx`)).statusCode).toBe(404); // bad signature
    expect((await get(`/api/receipts/${b.id}.${good.split('.')[1]}`)).statusCode).toBe(404); // a's signature on b's id
    expect((await get('/api/receipts/not-a-token')).statusCode).toBe(404);
    expect((await get('/api/receipts/.')).statusCode).toBe(404);
    expect(giftIdFromToken(good)).toBe(a.id);
    expect(giftIdFromToken(`${a.id}.`)).toBeNull();
  }, 60_000);

  it('in batch mode the gift notice is a template carrying the receipt token as its URL button suffix', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: { ...airtime, giftDeliveryMode: 'batch' }, wallet: 10_000 });
    await complete(w, 0);
    const g = await giftOf(w, 0);
    await prisma.giftDelivery.update({ where: { id: g.id }, data: { scheduledFor: new Date() } });
    await processDueGifts();
    await runSendWorkerOnce(50);
    const t = (await chatOf(0)).filter((c) => c.template).at(-1).template;
    expect(t.name).toBe('survey_gift_notice');
    expect(t.urlParams).toEqual([receiptToken(g.id)]);
  });

  it('the receipt shows what the participant received — masked phone, no fee, no wallet — and escapes hostile text', async () => {
    const w = await buildWorld(app, { plan: 'growth', gift: airtime, wallet: 10_000 });
    await complete(w, 0);
    await processDueGifts();
    await prisma.survey.update({ where: { id: w.surveyId }, data: { title: '<img src=x onerror=alert(1)>' } });
    const data = (await loadReceipt((await giftOf(w, 0)).id))!;
    const html = buildReceiptHtml(data);
    expect(html).toContain('500 FCFA');
    expect(html).toContain('+237 6XX XXX 000'); // masked, never the full number
    expect(html).not.toContain('2376771000');
    expect(html).not.toMatch(/525|fee|frais/i); // the owner's cost is not the participant's business
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
