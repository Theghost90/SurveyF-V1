import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { readMockMailbox } from '../src/services/mail';
import { processWebhookPayload } from '../src/services/survey/handler';
import { attachAccount } from '../src/services/whatsapp/connect';
import { getGateway, setGateway, type WhatsAppGateway } from '../src/services/whatsapp/gateway';
import { mockCalls } from '../src/services/whatsapp/mock';
import { buildWorld, makeApp, postWebhook, registerOwner, resetAll } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); mockCalls.length = 0; });
afterEach(() => setGateway(null));

/**
 * WA-11..WA-13 (D-19): Embedded Signup v5 with coexistence, in the two stories we agreed on.
 *   Armand  = a number that never had WhatsApp: standard onboarding, registered for the Cloud API with a PIN, nothing to sync.
 *   Mireille = a number in a WhatsApp Business app: coexistence, NO registration, contacts and history sync asked at once, the owner keeps the app.
 * The mock stands for Meta here (ids `mock-app-…` stand for a number that is in a Business app); docs/META_CHECK.md lists what only a real number can prove.
 */
const logger = { warn: () => undefined };
const bare = () => registerOwner(app, { whatsapp: false });
const connect = (o: Awaited<ReturnType<typeof bare>>, scenario: 'new' | 'business_app', declared?: string) => o.post('/api/whatsapp/accounts/mock', { scenario, ...(declared ? { declared } : {}) });
const accountOf = (userId: string) => prisma.whatsAppAccount.findFirstOrThrow({ where: { userId } });

describe('Armand: a number that never had WhatsApp', () => {
  it('is registered with a PIN, is not in coexistence, and asks Meta for no sync', async () => {
    const o = await bare();
    const r = await connect(o, 'new');
    expect(r.status).toBe(201);
    const a = r.items[0];
    expect(a).toMatchObject({ mode: 'cloud', declaredSituation: 'new', signupVersion: 'v5', registered: true, sync: { state: 'none', contacts: 0 }, disconnect: null });
    expect(mockCalls.map((c) => c.op)).toEqual(['register']);
    expect(mockCalls[0]!.detail).toBe('pin:6');
    // the PIN is kept encrypted, never as six digits, and never returned
    const row = await accountOf(o.userId);
    expect(row.registerPin).toBeTruthy();
    expect(row.registerPin).not.toMatch(/^\d{6}$/);
    expect(JSON.stringify(r)).not.toContain(row.registerPin!);
    expect(JSON.stringify(r)).not.toContain('accessToken');
  });
});

describe('Mireille: a number in a WhatsApp Business app', () => {
  it('is connected in coexistence, is NOT registered, and the contacts and history sync are asked for at once', async () => {
    const o = await bare();
    const r = await connect(o, 'business_app');
    expect(r.status).toBe(201);
    expect(r.items[0]).toMatchObject({ mode: 'coexistence', declaredSituation: 'business_app', registered: false, sync: { state: 'pending' } });
    expect(mockCalls.map((c) => c.op)).toEqual(['sync:smb_app_state_sync', 'sync:history']); // never `register`: Meta says the number is already registered
    const row = await accountOf(o.userId);
    expect(row.registerPin).toBeNull();
    expect(row.syncStartedAt).not.toBeNull();
  });

  it('receives her contacts without consent, and only her confirmation makes them eligible; a STOP is never overridden', async () => {
    const o = await bare();
    const acct = (await connect(o, 'business_app')).items[0];
    // someone who already sent STOP is in her address book too
    const stopped = await prisma.contact.create({ data: { userId: o.userId, name: 'Stopped', phone: '+237650000012', optedOutAt: new Date(), consentSource: 'whatsapp_stop' } });
    const ev = await o.post(`/api/whatsapp/accounts/${acct.id}/mock-event`, { event: 'contacts' });
    expect(ev.status).toBe(200);
    expect(ev.items[0].sync.contacts).toBe(4);
    expect(ev.items[0].sync.state).toBe('partial');
    expect(ev.items[0].pendingAppContacts).toBe(3); // 4 sent, 1 already existed (and stays as it was)
    const fresh = await prisma.contact.findMany({ where: { userId: o.userId, consentSource: 'whatsapp_app_sync' } });
    expect(fresh).toHaveLength(3);
    for (const c of fresh) { expect(c.consentAt).toBeNull(); expect(c.tags).toEqual(['app-contact']); }
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: stopped.id } })).optedOutAt).not.toBeNull();

    // not eligible for a survey yet: the send finds nobody to invite
    const survey = await o.post('/api/surveys', { title: 'Avis', language: 'en', questions: [{ type: 'text', text: 'Q ?', required: true }] });
    expect((await o.post(`/api/surveys/${survey.id}/publish`)).status).toBe(200);
    const early = await o.post(`/api/surveys/${survey.id}/send`, { all: true, acceptMarketingCost: true });
    expect(early.status).toBe(400);
    expect(early.body.error).toBe('no_eligible_contacts');

    expect((await o.raw('POST', '/api/whatsapp/app-contacts/confirm', { consent: false })).status).toBe(400); // an explicit attestation, not a bare call
    const ok = await o.post('/api/whatsapp/app-contacts/confirm', { consent: true });
    expect(ok.confirmed).toBe(3);
    const after = await prisma.contact.findMany({ where: { userId: o.userId, consentSource: 'owner_attested_app_contacts' } });
    expect(after).toHaveLength(3);
    expect(after.every((c) => c.consentAt)).toBe(true);
    const still = await prisma.contact.findUniqueOrThrow({ where: { id: stopped.id } });
    expect(still.consentAt).toBeNull(); // STOP stays STOP
    expect(still.optedOutAt).not.toBeNull();
    expect((await o.get('/api/whatsapp/accounts')).items[0].pendingAppContacts).toBe(0);
    // and now the three can be invited, the one who sent STOP still cannot
    const late = await o.post(`/api/surveys/${survey.id}/send`, { all: true, acceptMarketingCost: true });
    expect(late.status).toBe(200);
    expect(await prisma.surveyRecipient.count({ where: { surveyId: survey.id } })).toBe(3);
  });

  it('another owner cannot confirm, read events of, or play events on her number', async () => {
    const m = await bare();
    const acct = (await connect(m, 'business_app')).items[0];
    await m.post(`/api/whatsapp/accounts/${acct.id}/mock-event`, { event: 'contacts' });
    const other = await registerOwner(app, { whatsapp: false });
    expect((await other.post(`/api/whatsapp/accounts/${acct.id}/mock-event`, { event: 'disconnect' })).status).toBe(404);
    expect((await other.post(`/api/whatsapp/accounts/${acct.id}/sync`)).status).toBe(404);
    expect((await other.post('/api/whatsapp/app-contacts/confirm', { consent: true })).confirmed).toBe(0);
    expect((await prisma.contact.count({ where: { userId: m.userId, consentAt: null } }))).toBe(4);
    expect((await accountOf(m.userId)).status).toBe('active');
  });

  it('counts the history and the echoes, reads and stores no message text', async () => {
    const o = await bare();
    const acct = (await connect(o, 'business_app')).items[0];
    const row = await accountOf(o.userId);
    const h = await o.post(`/api/whatsapp/accounts/${acct.id}/mock-event`, { event: 'history' });
    expect(h.items[0].sync).toMatchObject({ state: 'done', historyProgress: 100, historyThreads: 2 });
    expect(row.lastAppActivityAt).toBeNull();
    const e = await o.post(`/api/whatsapp/accounts/${acct.id}/mock-event`, { event: 'echo' });
    expect(e.items[0].lastAppActivityAt).toBeTruthy();
    // a real-shaped webhook with text in it: the text goes nowhere
    await processWebhookPayload({ object: 'whatsapp_business_account', entry: [{ id: row.wabaId, changes: [{ field: 'smb_message_echoes', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: row.phoneNumberId }, message_echoes: [{ from: '1', to: '2', id: 'w', type: 'text', text: { body: 'TOP-SECRET-LINE' } }] } }] }] }, { info: () => undefined, warn: () => undefined, error: () => undefined });
    expect(JSON.stringify(await prisma.whatsAppAccount.findMany())).not.toContain('TOP-SECRET-LINE');
    expect(JSON.stringify(await prisma.contact.findMany())).not.toContain('TOP-SECRET-LINE');
  });

  it('a refusal to share the history is recorded as declined, which is fine', async () => {
    const o = await bare();
    await connect(o, 'business_app');
    const row = await accountOf(o.userId);
    await processWebhookPayload({ object: 'whatsapp_business_account', entry: [{ id: row.wabaId, changes: [{ field: 'history', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: row.phoneNumberId }, history: [{ errors: [{ code: 2593109 }] }] } }] }] }, { info: () => undefined, warn: () => undefined, error: () => undefined });
    expect((await accountOf(o.userId)).syncState).toBe('declined');
  });

  it('keeps the signed webhook route working for the new fields (a real POST, signed)', async () => {
    const o = await bare();
    await connect(o, 'business_app');
    const row = await accountOf(o.userId);
    const payload = { object: 'whatsapp_business_account', entry: [{ id: row.wabaId, changes: [{ field: 'smb_app_state_sync', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: row.phoneNumberId }, state_sync: [{ type: 'contact', contact: { full_name: 'Awa', phone_number: '237650000099' }, action: 'add' }] } }] }] };
    expect((await postWebhook(app, payload)).statusCode).toBe(200);
    expect((await accountOf(o.userId)).contactsReceived).toBe(1);
    expect((await postWebhook(app, payload, { sign: false })).statusCode).toBe(401); // unsigned is still refused
    expect(await prisma.contact.count({ where: { userId: o.userId } })).toBe(1);
  });
});

describe('disconnection (PARTNER_REMOVED)', () => {
  it('pauses the number, says why in our own words, e-mails once, and keeps surveys and contacts', async () => {
    const o = await bare();
    const acct = (await connect(o, 'business_app')).items[0];
    await o.post(`/api/whatsapp/accounts/${acct.id}/mock-event`, { event: 'contacts' });
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).email;
    const d = await o.post(`/api/whatsapp/accounts/${acct.id}/mock-event`, { event: 'disconnect' });
    expect(d.items[0]).toMatchObject({ status: 'disconnected', disconnect: { reason: 'PRIMARY_INACTIVITY', by: 'SYSTEM' } });
    const mail = (await readMockMailbox(email)).filter((m) => m.kind === 'whatsapp_disconnected');
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain('14 days');
    expect(mail[0]!.text).not.toMatch(/PRIMARY_INACTIVITY/); // Meta's code is never shown, only our wording
    await o.post(`/api/whatsapp/accounts/${acct.id}/mock-event`, { event: 'disconnect' }); // Meta retries: no second mail
    expect((await readMockMailbox(email)).filter((m) => m.kind === 'whatsapp_disconnected')).toHaveLength(1);
    expect(await prisma.contact.count({ where: { userId: o.userId } })).toBe(4);
    expect(await prisma.auditLog.count({ where: { userId: o.userId, action: 'whatsapp_disconnected' } })).toBe(1);
  });

  it('sending to a disconnected number is refused, and a webhook for an unknown account is ignored', async () => {
    const w = await buildWorld(app, { contacts: 2, send: false });
    const row = await accountOf(w.owner.userId);
    await processWebhookPayload({ entry: [{ id: 'nobody', changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED', waba_info: { waba_id: 'nobody' }, disconnection_info: { reason: 'CHANGE_NUMBER' } } }] }] }, { info: () => undefined, warn: () => undefined, error: () => undefined });
    expect((await accountOf(w.owner.userId)).status).toBe('active');
    await processWebhookPayload({ entry: [{ id: 'partner', changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED', waba_info: { waba_id: row.wabaId }, disconnection_info: { reason: 'CHANGE_NUMBER', initiated_by: 'USER' } } }] }] }, { info: () => undefined, warn: () => undefined, error: () => undefined });
    expect((await accountOf(w.owner.userId)).status).toBe('disconnected');
    const sent = await w.owner.post(`/api/surveys/${w.surveyId}/send`, { all: true, acceptMarketingCost: true });
    expect(sent.status).toBe(409);
    expect(sent.body.error).toBe('whatsapp_not_connected'); // nothing is queued, nothing reaches a participant
    expect(await prisma.surveyRecipient.count({ where: { surveyId: w.surveyId } })).toBe(0);
    expect(mockCalls.filter((c) => c.op.startsWith('sync'))).toHaveLength(0);
  });

  it('reconnecting puts the same number back in place: the surveys that point at it are kept, the disconnection is cleared', async () => {
    const o = await bare();
    const first = (await connect(o, 'business_app')).items[0];
    const survey = await o.post('/api/surveys', { title: 'Avis', language: 'fr', questions: [{ type: 'text', text: 'Q ?', required: true }] });
    await prisma.survey.update({ where: { id: survey.id }, data: { whatsappAccountId: first.id } });
    await o.post(`/api/whatsapp/accounts/${first.id}/mock-event`, { event: 'disconnect' });
    expect((await connect(o, 'business_app')).status).toBe(201);
    const accounts = await prisma.whatsAppAccount.findMany({ where: { userId: o.userId } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.id).toBe(first.id);
    expect(accounts[0]).toMatchObject({ status: 'active', disconnectReason: null, mode: 'coexistence', syncState: 'pending' });
    expect((await prisma.survey.findUniqueOrThrow({ where: { id: survey.id } })).whatsappAccountId).toBe(first.id);
    // Meta says it is back before we reconnected by hand: cleared too
    await o.post(`/api/whatsapp/accounts/${first.id}/mock-event`, { event: 'disconnect' });
    await o.post(`/api/whatsapp/accounts/${first.id}/mock-event`, { event: 'reconnect' });
    expect((await accountOf(o.userId)).status).toBe('active');
  });

  it('refuses a second connection while one is live', async () => {
    const o = await bare();
    await connect(o, 'new');
    const again = await connect(o, 'business_app');
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_connected');
  });
});

describe('Meta decides, not the browser', () => {
  const gw = (status: boolean | null, phones: Array<{ id: string; displayPhone: string }> = []): WhatsAppGateway => {
    const base = getGateway();
    return Object.assign(Object.create(base), { getAppStatus: async () => ({ isOnBizApp: status, platformType: null }), listPhoneNumbers: async () => phones }) as WhatsAppGateway;
  };
  const input = (phoneNumberId: string | null = 'mock-real-1') => ({ wabaId: 'waba-real-1', phoneNumberId, accessToken: 'mock-token-for-local-development' });

  it('when Meta says the number is in a Business app, that wins over what the browser said', async () => {
    const o = await bare();
    setGateway(gw(true));
    const a = await attachAccount(o.userId, input(), { embedded: { declared: 'new', browserIsOnBizApp: false } }, logger);
    expect(a.mode).toBe('coexistence');
    expect(mockCalls.some((c) => c.op === 'register')).toBe(false);
  });

  it('when Meta says it is not, the number is registered even if the browser said it was in an app', async () => {
    const o = await bare();
    setGateway(gw(false));
    const a = await attachAccount(o.userId, input(), { embedded: { declared: 'business_app', browserIsOnBizApp: true } }, logger);
    expect(a.mode).toBe('cloud');
    expect(a.registeredAt).not.toBeNull();
  });

  it('when Meta says nothing, the browser is the fallback; when neither says, nothing is changed', async () => {
    const o = await bare();
    setGateway(gw(null));
    const a = await attachAccount(o.userId, input(), { embedded: { declared: null, browserIsOnBizApp: true } }, logger);
    expect(a.mode).toBe('coexistence');
    await prisma.whatsAppAccount.deleteMany({ where: { userId: o.userId } });
    mockCalls.length = 0;
    await expect(attachAccount(o.userId, input('mock-real-2'), { embedded: { declared: null, browserIsOnBizApp: null } }, logger)).rejects.toMatchObject({ code: 'mode_unknown' });
    expect(await prisma.whatsAppAccount.count({ where: { userId: o.userId } })).toBe(0);
    expect(mockCalls).toHaveLength(0); // no register, no sync on a guess
  });

  it('a missing phone number id is looked up: one number is taken, none or several is refused', async () => {
    const o = await bare();
    setGateway(gw(false, [{ id: 'mock-only-1', displayPhone: '+237600000001' }]));
    expect((await attachAccount(o.userId, input(null), { embedded: { declared: 'new', browserIsOnBizApp: false } }, logger)).phoneNumberId).toBe('mock-only-1');
    await prisma.whatsAppAccount.deleteMany({ where: { userId: o.userId } });
    setGateway(gw(false, []));
    await expect(attachAccount(o.userId, input(null), { embedded: { declared: 'new', browserIsOnBizApp: false } }, logger)).rejects.toMatchObject({ code: 'phone_unknown' });
    setGateway(gw(false, [{ id: 'a', displayPhone: '' }, { id: 'b', displayPhone: '' }]));
    await expect(attachAccount(o.userId, input(null), { embedded: { declared: 'new', browserIsOnBizApp: false } }, logger)).rejects.toMatchObject({ code: 'phone_unknown' });
  });

  it('a registration that fails keeps the connection (the one-time code is spent) with a retry, and the retry works', async () => {
    const o = await bare();
    const base = getGateway();
    let fail = true;
    setGateway(Object.assign(Object.create(base), { getAppStatus: async () => ({ isOnBizApp: false, platformType: null }), registerPhone: async () => { if (fail) throw new Error('boom'); } }) as WhatsAppGateway);
    const a = await attachAccount(o.userId, input(), { embedded: { declared: 'new', browserIsOnBizApp: false } }, logger);
    expect(a).toMatchObject({ status: 'error', registeredAt: null });
    fail = false;
    const r = await o.post(`/api/whatsapp/accounts/${a.id}/register`);
    expect(r.status).toBe(200);
    expect(r.items[0]).toMatchObject({ status: 'active', registered: true });
  });

  it('the real Embedded Signup route still needs live mode, and credentials typed by hand still work and are not registered or synced', async () => {
    const o = await bare();
    expect((await o.post('/api/whatsapp/embedded-signup', { code: 'abcde', wabaId: 'w', phoneNumberId: 'p' })).status).toBe(400);
    const m = await o.post('/api/whatsapp/accounts', { wabaId: 'waba-hand-1', phoneNumberId: 'mock-hand-1', accessToken: 'mock-token-for-local-development' });
    expect(m.status).toBe(201);
    expect(m.items[0]).toMatchObject({ mode: 'cloud', signupVersion: null, sync: { state: 'none' } });
    expect(mockCalls).toHaveLength(0);
  });

  it('a sync that Meta refuses is marked failed and can be asked again', async () => {
    const o = await bare();
    const base = getGateway();
    let fail = true;
    setGateway(Object.assign(Object.create(base), { getAppStatus: async () => ({ isOnBizApp: true, platformType: null }), requestAppDataSync: async () => { if (fail) throw new Error('nope'); return { requestId: 'r' }; } }) as WhatsAppGateway);
    const a = await attachAccount(o.userId, input('mock-app-9'), { embedded: { declared: 'business_app', browserIsOnBizApp: true } }, logger);
    expect(a.syncState).toBe('failed');
    expect((await o.post(`/api/whatsapp/accounts/${a.id}/sync`)).status).toBe(400);
    fail = false;
    const r = await o.post(`/api/whatsapp/accounts/${a.id}/sync`);
    expect(r.status).toBe(200);
    expect(r.items[0].sync.state).toBe('pending');
  });
});

describe('WA-14: handing the survey out from the owner’s own number', () => {
  it('the join link carries what the share kit needs: the title, the language and a link that opens a chat with the connected number', async () => {
    const o = await bare();
    await connect(o, 'business_app');
    const s = await o.post('/api/surveys', { title: 'Avis clients', language: 'fr', questions: [{ type: 'text', text: 'Q ?', required: true }] });
    await o.post(`/api/surveys/${s.id}/publish`);
    const on = await o.put(`/api/surveys/${s.id}/join`, { enabled: true });
    expect(on.status).toBe(200);
    expect(on).toMatchObject({ title: 'Avis clients', lang: 'fr' });
    expect(on.link).toMatch(/^https:\/\/wa\.me\/\d+\?text=JOIN%20[a-z2-7]{26}$/);
    const { shareMessage, shareDeepLink } = await import('@surveyflow/shared');
    const msg = shareMessage('fr', on.title, on.link);
    expect(shareDeepLink(msg)).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(msg).toContain(on.link);
  });
});

describe('the config the web app reads', () => {
  it('names v5 so the launch is not served as v4 with coexistence off', async () => {
    const o = await bare();
    const c = await o.get('/api/whatsapp/config');
    expect(c.status).toBe(200);
    // no Meta app is configured in tests: the block is null, and when it is configured it carries the version
    expect(c.embeddedSignup).toBeNull();
  });
});
