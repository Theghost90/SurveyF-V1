import { currencyForCountry, type Currency } from '@surveyflow/shared';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { runSendWorkerOnce } from '../src/services/whatsapp/sender';
import { creditWallet } from '../src/services/wallet';

export const APP_SECRET = 'test-app-secret';
let counter = 0;

export async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

export async function resetAll() {
  await prisma.$executeRawUnsafe('TRUNCATE "User","SheetRow" RESTART IDENTITY CASCADE');
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

export async function registerOwner(app: FastifyInstance, over: Partial<{ email: string; plan: 'trial' | 'starter' | 'growth' | 'business' }> = {}): Promise<Client> {
  counter++;
  const res = await app.inject({
    method: 'POST', url: '/api/auth/register', headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ businessName: 'Boulangerie Akwa', name: 'Jean-Paul', email: over.email ?? `owner${counter}@example.com`, phone: '+237 677 00 00 01', password: 'correct-horse-battery', locale: 'en' }),
  });
  const body = JSON.parse(res.body);
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  if (over.plan && over.plan !== 'trial') await setPlan(body.user.id, over.plan);
  return client(app, body.token, body.user.id);
}

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
export async function buildWorld(app: FastifyInstance, opts: { country?: string; contacts?: number; plan?: 'trial' | 'starter' | 'growth' | 'business'; gift?: Record<string, unknown>; send?: boolean; questions?: unknown[]; wallet?: number } = {}): Promise<World> {
  const owner = await registerOwner(app, { plan: opts.plan });
  // An owner in another country: their currency (and so their wallet's) is that country's, as if they had registered from there.
  const currency = currencyForCountry(opts.country ?? 'CM');
  if (opts.country) await prisma.user.update({ where: { id: owner.userId }, data: { country: opts.country, preferredCurrency: currency } });
  if (opts.wallet) await fundWallet(owner.userId, opts.wallet, currency);
  const acct = await owner.post('/api/whatsapp/accounts/mock');
  if (acct.status !== 201) throw new Error('mock account: ' + JSON.stringify(acct));
  const phoneNumberId = acct.items[0].phoneNumberId as string;

  const contactIds: string[] = [];
  for (let i = 0; i < (opts.contacts ?? 3); i++) {
    const c = await owner.post('/api/contacts', { name: `Contact ${i + 1}`, phone: `+2376771000${String(i).padStart(2, '0')}`, tags: i % 2 ? ['vip'] : [], consent: true });
    if (c.status !== 201) throw new Error('contact: ' + JSON.stringify(c));
    contactIds.push(c.id);
  }
  const s = await owner.post('/api/surveys', { title: 'Customer Satisfaction', language: 'en', questions: opts.questions ?? sampleQuestions(), gift: opts.gift ?? {} });
  if (s.status !== 201) throw new Error('survey: ' + JSON.stringify(s));
  const pub = await owner.post(`/api/surveys/${s.id}/publish`);
  if (pub.status !== 200) throw new Error('publish: ' + JSON.stringify(pub));
  if (opts.send !== false) {
    const sent = await owner.post(`/api/surveys/${s.id}/send`, { all: true });
    if (sent.status !== 200) throw new Error('send: ' + JSON.stringify(sent));
    await runSendWorkerOnce(100);
  }
  return { owner, contactIds, surveyId: s.id, phoneNumberId, questions: pub.questions };
}

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
