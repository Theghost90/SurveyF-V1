import { currencyForCountry, type Currency } from '@surveyflow/shared';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { runSendWorkerOnce } from '../src/services/whatsapp/sender';
import { creditWallet } from '../src/services/wallet';
import { encryptSecret } from '../src/lib/crypto';
import { hashPassword } from '../src/lib/password';
import { createUserExplore } from '../src/routes/auth';
import { readMockMailbox } from '../src/services/mail';
import { createSession } from '../src/services/security/sessions';
import { buildReceiptHtml, type ReceiptData } from '../src/services/receipts';

export const APP_SECRET = 'test-app-secret';
let counter = 0;

export async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

/** Runs a database statement again when Postgres ends it as the victim of a deadlock, which is the answer it documents for that error. Any other failure is thrown at once. */
export async function retryOnDeadlock<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= attempts || !/\b40P01\b|deadlock detected/.test(String(err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

/**
 * A best-effort write the previous test left running (the funnel event "paid", say) locks its own table and then checks the User row it points at, while TRUNCATE locks
 * User first and its table after: Postgres ends one of the two with a deadlock error, and the reset is the one that is run again. Production has no TRUNCATE, so this
 * exists here only.
 */
export async function resetAll() {
  await retryOnDeadlock(() => prisma.$executeRawUnsafe('TRUNCATE "User","SheetRow","AuditLog","FinancialArchive" RESTART IDENTITY CASCADE'));
  await redis.flushdb();
}

export interface Client {
  token: string;
  userId: string;
  get: (url: string) => Promise<any>;
  post: (url: string, body?: unknown) => Promise<any>;
  put: (url: string, body?: unknown) => Promise<any>;
  del: (url: string) => Promise<any>;
  raw: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any; headers: Record<string, any>; rawBody: Buffer }>;
}

export function client(app: FastifyInstance, token: string, userId: string): Client {
  const raw = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as never, url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: body === undefined ? undefined : JSON.stringify(body) });
    let json: any = null;
    try { json = res.body ? JSON.parse(res.body) : null; } catch { /* binary */ }
    return { status: res.statusCode, json, headers: res.headers, rawBody: res.rawPayload };
  };
  const call = (method: string) => async (url: string, body?: unknown) => {
    const r = await raw(method, url, body);
    // HTTP status wins over any `status` field in the body (surveys have one).
    return { ...(r.json ?? {}), status: r.status, body: r.json };
  };
  return { token, userId, raw, get: call('GET'), post: call('POST'), put: call('PUT'), del: call('DELETE') };
}

/** A simulated WhatsApp number, attached directly (what POST /api/whatsapp/accounts/mock does, without the HTTP round trip). */
export async function connectMockWhatsApp(userId: string) {
  const n = ++counter;
  return prisma.whatsAppAccount.create({ data: { userId, wabaId: `mock-waba-t${n}`, phoneNumberId: `mock-t${n}-${Date.now().toString(36)}`, displayPhone: '+237600000000', accessToken: encryptSecret('mock-token'), status: 'active' } });
}

export const TEST_PASSWORD = 'correct-horse-battery';

/**
 * `whatsapp: false` = a brand-new owner who has not connected their number yet (most of the product refuses to work then).
 * The owner is created already CONFIRMED and signed in, without going through the e-mail link: most tests are about something else. The real sign-up,
 * confirmation and sign-in are covered by security-auth.test.ts (and `signUp` below does them end to end).
 */
export async function registerOwner(app: FastifyInstance, over: Partial<{ email: string; plan: 'trial' | 'starter' | 'growth' | 'business'; whatsapp: boolean; country: string; verified: boolean }> = {}): Promise<Client> {
  counter++;
  const country = over.country ?? 'CM';
  const user = await createUserExplore({
    email: over.email ?? `owner${counter}@example.com`, name: 'Jean-Paul', businessName: 'Boulangerie Akwa', phone: '+237677000001', passwordHash: await hashPassword(TEST_PASSWORD),
    country, locale: 'en', emailVerifiedAt: over.verified === false ? null : new Date(),
  });
  const t = await createSession(user.id, 'password', false, { ip: '127.0.0.1', userAgent: 'vitest', country: null });
  if (over.plan && over.plan !== 'trial') await setPlan(user.id, over.plan);
  if (over.whatsapp !== false) await connectMockWhatsApp(user.id);
  return client(app, t.accessToken, user.id);
}

export interface SignUpResult { status: number; email: string; client?: Client; verifyToken?: string; mails: Array<{ kind: string; links: string[] }> }

/** The real thing: POST /register, read the confirmation link from the (mock) mailbox, confirm, sign in. Stops early where the flow does. */
export async function signUp(app: FastifyInstance, over: Partial<{ email: string; country: string; locale: 'en' | 'fr'; password: string; headers: Record<string, string>; confirm: boolean }> = {}): Promise<SignUpResult> {
  counter++;
  const email = over.email ?? `signup${counter}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const res = await app.inject({
    method: 'POST', url: '/api/auth/register', headers: { 'content-type': 'application/json', ...(over.country ? { 'x-sf-country': over.country } : {}), ...(over.headers ?? {}) },
    payload: JSON.stringify({ businessName: 'Biz', name: 'Ada', email, phone: '+237 677 00 00 02', password: over.password ?? TEST_PASSWORD, locale: over.locale ?? 'en' }),
  });
  const mails = await readMockMailbox(email);
  const link = mails.find((m) => m.kind === 'verify_email')?.links.find((l) => l.includes('/verify-email?token='));
  const verifyToken = link ? decodeURIComponent(new URL(link).searchParams.get('token')!) : undefined;
  if (res.statusCode !== 202 || !verifyToken || over.confirm === false) return { status: res.statusCode, email, verifyToken, mails };
  const ok = await app.inject({ method: 'POST', url: '/api/auth/verify-email', headers: { 'content-type': 'application/json', ...(over.headers ?? {}) }, payload: JSON.stringify({ token: verifyToken, password: over.password ?? TEST_PASSWORD }) });
  if (ok.statusCode !== 200) return { status: ok.statusCode, email, verifyToken, mails };
  const login = await loginRaw(app, email, over.password ?? TEST_PASSWORD, over.headers);
  const body = JSON.parse(login.body);
  return { status: login.statusCode, email, verifyToken, mails, client: login.statusCode === 200 ? client(app, body.accessToken, body.user.id) : undefined };
}

/** Sign up FROM a country (the CDN header the website forwards), confirm the address, sign in: what a visitor in that country goes through. */
export async function registerFrom(app: FastifyInstance, country: string | undefined, over: Record<string, unknown> = {}): Promise<{ status: number; body: { user: any; accessToken?: string }; c: Client }> {
  counter++;
  const email = `reg${counter}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const headers = { 'content-type': 'application/json', ...(country ? { 'x-sf-country': country } : {}) };
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', headers, payload: JSON.stringify({ businessName: 'Biz', name: 'Ada', email, phone: '677 12 34 56', password: TEST_PASSWORD, ...over }) });
  const none = { status: res.statusCode, body: { user: undefined as any }, c: client(app, '', '') };
  if (res.statusCode !== 202) return none;
  const link = (await readMockMailbox(String(over.email ?? email))).find((m) => m.kind === 'verify_email')?.links[0];
  if (!link) return none;
  await app.inject({ method: 'POST', url: '/api/auth/verify-email', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ token: decodeURIComponent(new URL(link).searchParams.get('token')!), password: String(over.password ?? TEST_PASSWORD) }) });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: JSON.stringify({ email: String(over.email ?? email), password: String(over.password ?? TEST_PASSWORD) }) });
  const body = JSON.parse(login.body);
  return { status: login.statusCode, body, c: client(app, body.accessToken ?? '', body.user?.id ?? '') };
}

export const loginRaw = (app: FastifyInstance, email: string, password: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify({ email, password, ...extra }) });

export async function setPlan(userId: string, plan: 'trial' | 'starter' | 'growth' | 'business') {
  const now = new Date();
  await prisma.user.update({ where: { id: userId }, data: { plan } });
  await prisma.subscription.update({
    where: { userId },
    data: { plan, status: plan === 'trial' ? 'trial' : 'active', amountFCFA: plan === 'trial' ? 0 : 14500, currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000) },
  });
}

/** Funds the gift wallet through the same code path a settled top-up uses, so balance and ledger stay consistent. */
export async function fundWallet(userId: string, amount: number, currency?: Currency) {
  await prisma.$transaction((tx) => creditWallet(tx, userId, amount, 'topup', `test-topup-${Date.now()}`, 'test top-up', currency));
}

/** balance == sum(ledger) and never negative: the two properties the wallet must hold after ANY sequence of operations. */
export async function walletState(userId: string) {
  const [u, agg, entries] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { giftBalance: true } }),
    prisma.walletEntry.aggregate({ where: { userId }, _sum: { delta: true } }),
    prisma.walletEntry.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
  ]);
  return { balance: u.giftBalance, ledgerSum: agg._sum.delta ?? 0, entries };
}

export const sampleQuestions = () => [
  { text: 'How satisfied are you with our service?', type: 'button', required: true, options: [{ id: 'vs', label: 'Very satisfied' }, { id: 'ne', label: 'Neutral' }, { id: 'un', label: 'Unsatisfied' }] },
  { text: 'Which product do you use most?', type: 'list', required: true, options: ['Product A', 'Product B', 'Product C', 'Product D'].map((label, i) => ({ id: `p${i}`, label })) },
  { text: 'Any suggestions for improvement?', type: 'text', required: false, options: null },
];

export interface World {
  owner: Client;
  contactIds: string[];
  surveyId: string;
  phoneNumberId: string;
  questions: Array<{ id: string; type: string; options: Array<{ id: string; label: string }> | null }>;
}

/** Owner + simulated WhatsApp number + N contacts + a published survey, invitations sent (worker run). */
export async function buildWorld(app: FastifyInstance, opts: { country?: string; contacts?: number; plan?: 'trial' | 'starter' | 'growth' | 'business'; gift?: Record<string, unknown>; send?: boolean; questions?: unknown[]; wallet?: number; survey?: Record<string, unknown> } = {}): Promise<World> {
  const owner = await registerOwner(app, { plan: opts.plan });
  // An owner in another country: their currency (and so their wallet's) is that country's, as if they had registered from there.
  const currency = currencyForCountry(opts.country ?? 'CM');
  if (opts.country) await prisma.user.update({ where: { id: owner.userId }, data: { country: opts.country, preferredCurrency: currency } });
  if (opts.wallet) await fundWallet(owner.userId, opts.wallet, currency);
  const acct = await owner.get('/api/whatsapp/accounts');
  const phoneNumberId = acct.items[0].phoneNumberId as string;

  const contactIds: string[] = [];
  for (let i = 0; i < (opts.contacts ?? 3); i++) {
    const c = await owner.post('/api/contacts', { name: `Contact ${i + 1}`, phone: `+2376771000${String(i).padStart(2, '0')}`, tags: i % 2 ? ['vip'] : [], consent: true });
    if (c.status !== 201) throw new Error('contact: ' + JSON.stringify(c));
    contactIds.push(c.id);
  }
  const s = await owner.post('/api/surveys', { title: 'Customer Satisfaction', language: 'en', questions: opts.questions ?? sampleQuestions(), gift: opts.gift ?? {}, ...(opts.survey ?? {}) });
  if (s.status !== 201) throw new Error('survey: ' + JSON.stringify(s));
  const pub = await owner.post(`/api/surveys/${s.id}/publish`);
  if (pub.status !== 200) throw new Error('publish: ' + JSON.stringify(pub));
  if (opts.send !== false) {
    const sent = await owner.post(`/api/surveys/${s.id}/send`, { all: true, acceptMarketingCost: true }); // (WA-03: the cost warning is acknowledged here; message-category.test.ts is where it is tested)
    if (sent.status !== 200) throw new Error('send: ' + JSON.stringify(sent));
    await runSendWorkerOnce(100);
  }
  return { owner, contactIds, surveyId: s.id, phoneNumberId, questions: pub.questions };
}

/**
 * What a receipt says in words. Its number is the tail of a random id and its reference comes from the provider, so either can spell "fee" or "525" by chance
 * (about one run in 4,000); a test that looks for those words on the page must not read them.
 */
export const receiptWords = (data: ReceiptData) => buildReceiptHtml(data).replaceAll(data.number, '').replaceAll(data.reference, '');

// ---- Meta webhook helpers --------------------------------------------------------------------

export const waIdOf = (i: number) => `2376771000${String(i).padStart(2, '0')}`;

export function metaPayload(phoneNumberId: string, messages: unknown[], statuses: unknown[] = []) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '237600000000', phone_number_id: phoneNumberId }, messages, statuses } }] }],
  };
}

let wamid = 0;
export const textMsg = (from: string, body: string, id = `wamid.T${++wamid}`) => ({ from, id, type: 'text', text: { body }, timestamp: '1' });
export const replyMsg = (from: string, replyId: string, kind: 'button_reply' | 'list_reply' = 'button_reply', id = `wamid.R${++wamid}`) => ({ from, id, type: 'interactive', interactive: { type: kind, [kind]: { id: replyId, title: 'x' } }, timestamp: '1' });
export const templateBtn = (from: string, payload: string, id = `wamid.B${++wamid}`) => ({ from, id, type: 'button', button: { payload, text: 'x' }, timestamp: '1' });

export async function postWebhook(app: FastifyInstance, payload: unknown, opts: { sign?: boolean; secret?: string } = {}) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.sign !== false) headers['x-hub-signature-256'] = 'sha256=' + createHmac('sha256', opts.secret ?? APP_SECRET).update(raw).digest('hex');
  return app.inject({ method: 'POST', url: '/api/webhook/whatsapp', headers, payload: raw });
}

export async function say(app: FastifyInstance, w: World, contactIdx: number, message: (from: string) => unknown) {
  const res = await postWebhook(app, metaPayload(w.phoneNumberId, [message(waIdOf(contactIdx))]));
  if (res.statusCode !== 200) throw new Error(`webhook ${res.statusCode}: ${res.body}`);
}

export async function chatOf(contactIdx: number) {
  // chats are keyed by business number + participant; tests flush Redis, so exactly one key matches
  const keys = await redis.keys(`sf:mock:chat:*:${waIdOf(contactIdx)}`);
  const raw = keys.length ? await redis.lrange(keys[0]!, 0, -1) : [];
  return raw.map((r) => JSON.parse(r));
}

export const answerIdFor = (q: { id: string; options: Array<{ id: string }> | null }, optIdx: number) => `a:${q.id}:${q.options![optIdx]!.id}`;
