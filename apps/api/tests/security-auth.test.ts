import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { verifyCaptcha } from '../src/lib/captcha';
import { prisma } from '../src/lib/prisma';
import { rlCredentials } from '../src/lib/ratelimit';
import { redis } from '../src/lib/redis';
import { readMockMailbox } from '../src/services/mail';
import { PAIR_FREE, checkLoginGuard, delaySeconds } from '../src/services/security/login-guard';
import { signAccessToken } from '../src/lib/jwt';
import { TEST_PASSWORD, loginRaw, makeApp, registerOwner, resetAll, signUp } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
beforeEach(async () => { await resetAll(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'content-type': 'application/json', ...headers }, payload: body === undefined ? undefined : JSON.stringify(body) });
const asUser = (token: string) => ({ authorization: `Bearer ${token}` });
const json = (r: { body: string }) => JSON.parse(r.body);
const mailsOf = async (email: string, kind?: string) => (await readMockMailbox(email)).filter((m) => !kind || m.kind === kind);
const tokenIn = async (email: string, kind: string) => {
  const link = (await mailsOf(email, kind))[0]?.links.find((l) => l.includes('token='));
  return link ? decodeURIComponent(new URL(link).searchParams.get('token')!) : undefined;
};
const register = (email: string, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  call('POST', '/api/auth/register', { businessName: 'Biz', name: 'Ada', email, phone: '677 00 00 02', password: TEST_PASSWORD, locale: 'en', ...over }, headers);
const confirm = async (email: string) => call('POST', '/api/auth/verify-email', { token: await tokenIn(email, 'verify_email') });
const login = (email: string, password = TEST_PASSWORD, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) => loginRaw(app, email, password, headers, extra);
const auditRows = (action: string, userId?: string) => prisma.auditLog.findMany({ where: { action, ...(userId ? { userId } : {}) } });

describe('sign-up (findings 1 and 9)', () => {
  it('answers 202 with the same body for a new address, a waiting one and a confirmed one: a stranger learns nothing about who is a customer', async () => {
    const a = await register('ada@example.com');
    const again = await register('ada@example.com');
    await confirm('ada@example.com');
    const confirmed = await register('ada@example.com', { name: 'Someone else', password: 'another-long-password-9' });
    for (const r of [a, again, confirmed]) expect(r.statusCode).toBe(202);
    expect(again.body).toBe(a.body);
    expect(confirmed.body).toBe(a.body);
    expect(json(a)).toEqual({ ok: true });
  });

  it('takes the same time whether or not the address has an account, because the answer is held to a minimum (sign-up, resend and forgot password)', async () => {
    const original = env.AUTH_MIN_RESPONSE_MS;
    env.AUTH_MIN_RESPONSE_MS = 250;
    try {
      await register('known@example.com');
      await confirm('known@example.com');
      await register('waiting@example.com');
      const timed = async (fn: () => Promise<unknown>) => { const t = Date.now(); await fn(); return Date.now() - t; };
      const runs = {
        'sign-up, confirmed address': await timed(() => register('known@example.com')),
        'sign-up, new address': await timed(() => register('brand-new@example.com')),
        'resend, unknown address': await timed(() => call('POST', '/api/auth/verify-email/resend', { email: 'nobody@example.com' })),
        'resend, waiting address': await timed(() => call('POST', '/api/auth/verify-email/resend', { email: 'waiting@example.com' })),
        'forgot, unknown address': await timed(() => call('POST', '/api/auth/password/forgot', { email: 'nobody@example.com' })),
        'forgot, real address': await timed(() => call('POST', '/api/auth/password/forgot', { email: 'known@example.com' })),
      };
      for (const [what, ms] of Object.entries(runs)) expect(ms, what).toBeGreaterThanOrEqual(245);
    } finally { env.AUTH_MIN_RESPONSE_MS = original; }
  });

  it('the e-mail is handed to the provider after the answer, and is there once the mail system is idle (so its delay cannot give an address away)', async () => {
    const r = await register('later@example.com');
    expect(r.statusCode).toBe(202);
    expect(await mailsOf('later@example.com', 'verify_email')).toHaveLength(1); // readMockMailbox waits for anything still in flight
    await call('POST', '/api/auth/password/forgot', { email: 'later@example.com' });
    expect(await mailsOf('later@example.com', 'reset_password')).toHaveLength(1);
  });

  it('a confirmed account keeps its address, is not changed by a second sign-up, and its owner is told', async () => {
    await register('ada@example.com');
    await confirm('ada@example.com');
    await register('ada@example.com', { name: 'Intruder', password: 'another-long-password-9' });
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.com' } });
    expect(u.name).toBe('Ada');
    expect((await login('ada@example.com')).statusCode).toBe(200);
    expect((await login('ada@example.com', 'another-long-password-9')).statusCode).toBe(401);
    expect(await mailsOf('ada@example.com', 'register_existing')).toHaveLength(1);
    await register('ada@example.com');
    expect(await mailsOf('ada@example.com', 'register_existing')).toHaveLength(1); // at most one a hour per mailbox: nobody can flood an inbox through this form
  });

  it('an address that was never confirmed cannot be squatted: the real owner replaces the registration', async () => {
    await register('victim@example.com', { name: 'Attacker', password: 'attacker-password-1234' });
    const squatterToken = await tokenIn('victim@example.com', 'verify_email');
    await register('victim@example.com', { name: 'Victim', password: 'orchid-garden-seventy-72' });
    expect(await prisma.user.count({ where: { email: 'victim@example.com' } })).toBe(1);
    expect(json(await call('POST', '/api/auth/verify-email', { token: squatterToken })).error).toBe('invalid_token'); // the attacker's own link died with their row
    expect((await confirm('victim@example.com')).statusCode).toBe(200);
    expect((await login('victim@example.com', 'attacker-password-1234')).statusCode).toBe(401);
    expect((await login('victim@example.com', 'orchid-garden-seventy-72')).statusCode).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'victim@example.com' } })).name).toBe('Victim');
    expect(await auditRows('unverified_account_replaced')).toHaveLength(1);
  });

  it('one mailbox is one account, however it is spelled (aliases cannot be used to get around the Explore cap)', async () => {
    await register('john.doe@gmail.com');
    await confirm('john.doe@gmail.com');
    for (const alias of ['johndoe@gmail.com', 'J.O.H.N.D.O.E+shop@gmail.com', 'johndoe@googlemail.com']) {
      expect((await register(alias)).statusCode).toBe(202);
    }
    expect(await prisma.user.count()).toBe(1);
    expect((await login('J.Doe+anything@gmail.com')).statusCode).toBe(401); // john.doe is not j.doe
    expect((await login('JohnDoe+x@Gmail.com')).statusCode).toBe(200);
    expect((await login('JOHN.DOE@gmail.com')).statusCode).toBe(200);
  });

  it('refuses weak passwords before anything is created, with a code the website translates', async () => {
    const cases: Array<[string, string, string]> = [
      ['weak1@example.com', 'short', 'password_too_short'], ['weak2@example.com', 'password123', 'password_too_common'], ['weak3@example.com', 'weak3-is-my-name', 'password_contains_email'], ['weak4@example.com', 'x'.repeat(129), 'validation_error'],
    ];
    for (const [email, password, code] of cases) {
      const r = await register(email, { password });
      expect(r.statusCode, email).toBe(400);
      expect(json(r).error, email).toBe(code);
    }
    expect(await prisma.user.count()).toBe(0);
    expect(json(await register('weak@example.com', { phone: 'not a phone' })).error).toBe('invalid_phone');
    expect((await register('not-an-email')).statusCode).toBe(400);
  });

  it('carries the chosen plan through the confirmation e-mail', async () => {
    await register('plan@example.com', { plan: 'growth', interval: 'annual' });
    const r = await confirm('plan@example.com');
    expect(json(r)).toEqual({ ok: true, plan: 'growth', interval: 'annual' });
  });

  it('limits sign-ups from one connection per hour (generous: many subscribers share one address on a mobile network)', async () => {
    expect(env.SIGNUP_PER_IP_HOUR).toBe(30);
    const saved = env.SIGNUP_PER_IP_HOUR;
    env.SIGNUP_PER_IP_HOUR = 6;
    try {
      for (let i = 0; i < 6; i++) expect((await register(`bulk${i}@example.com`)).statusCode).toBe(202);
      const r = await register('bulk-over@example.com');
      expect(r.statusCode).toBe(429);
      expect(json(r).error).toBe('rate_limited');
      expect((await register('bulk-other-ip@example.com', {}, { 'x-sf-client-ip': '198.51.100.7' })).statusCode).toBe(202);
    } finally { env.SIGNUP_PER_IP_HOUR = saved; }
  });

  it('exposes only what the forms need', async () => {
    const r = json(await call('GET', '/api/auth/config'));
    expect(r).toMatchObject({ captcha: null, emailMode: 'demo', passwordMinLength: 10 });
    expect(JSON.stringify(r)).not.toMatch(/secret/i);
  });
});

describe('the confirmation link', () => {
  it('works once; a used, expired, foreign or invented link is refused with the same answer', async () => {
    await register('v@example.com');
    const token = (await tokenIn('v@example.com', 'verify_email'))!;
    expect((await call('POST', '/api/auth/verify-email', { token })).statusCode).toBe(200);
    const second = await call('POST', '/api/auth/verify-email', { token });
    expect(second.statusCode).toBe(400);
    expect(json(second).error).toBe('invalid_token');
    expect(json(await call('POST', '/api/auth/verify-email', { token: 'x'.repeat(43) })).error).toBe('invalid_token');

    await register('e@example.com');
    const expired = (await tokenIn('e@example.com', 'verify_email'))!;
    await prisma.emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) }, where: { usedAt: null } });
    expect(json(await call('POST', '/api/auth/verify-email', { token: expired })).error).toBe('invalid_token');
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'e@example.com' } })).emailVerifiedAt).toBeNull();
  });

  it('a password-reset link cannot confirm an address, nor the other way round', async () => {
    await register('x@example.com');
    await call('POST', '/api/auth/password/forgot', { email: 'x@example.com' });
    const reset = (await tokenIn('x@example.com', 'reset_password'))!;
    const verify = (await tokenIn('x@example.com', 'verify_email'))!;
    expect(json(await call('POST', '/api/auth/verify-email', { token: reset })).error).toBe('invalid_token');
    expect(json(await call('POST', '/api/auth/password/reset', { token: verify, password: 'a-brand-new-password-77' })).error).toBe('invalid_token');
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'x@example.com' } })).emailVerifiedAt).toBeNull();
  });

  it('is stored hashed: a copy of the database cannot confirm anybody', async () => {
    await register('h@example.com');
    const token = (await tokenIn('h@example.com', 'verify_email'))!;
    const rows = await prisma.emailToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('a new link replaces the previous one, and asking again is limited and answers the same for any address', async () => {
    await register('r@example.com');
    const first = (await tokenIn('r@example.com', 'verify_email'))!;
    expect((await call('POST', '/api/auth/verify-email/resend', { email: 'r@example.com' })).statusCode).toBe(202);
    const second = (await tokenIn('r@example.com', 'verify_email'))!;
    expect(second).not.toBe(first);
    expect(json(await call('POST', '/api/auth/verify-email', { token: first })).error).toBe('invalid_token');
    expect((await call('POST', '/api/auth/verify-email', { token: second })).statusCode).toBe(200);

    expect((await call('POST', '/api/auth/verify-email/resend', { email: 'nobody@example.com' })).body).toBe('{"ok":true}');
    expect(await mailsOf('nobody@example.com')).toHaveLength(0);
    expect((await call('POST', '/api/auth/verify-email/resend', { email: 'r@example.com' })).statusCode).toBe(202); // already confirmed: nothing sent
    expect(await mailsOf('r@example.com', 'verify_email')).toHaveLength(2);

    await register('limit@example.com');
    for (let i = 0; i < 6; i++) await call('POST', '/api/auth/verify-email/resend', { email: 'limit@example.com' });
    expect((await mailsOf('limit@example.com', 'verify_email')).length).toBeLessThanOrEqual(4); // the sign-up mail plus three
  });

  it('until the address is confirmed the account is inert: nothing that sends, pays, connects or exports works', async () => {
    const owner = await registerOwner(app, { verified: false });
    const gated: Array<[Parameters<typeof call>[0], string, unknown?]> = [
      ['POST', '/api/surveys/x/publish'], ['POST', '/api/surveys/x/send', { all: true }], ['POST', '/api/surveys/x/remind', {}], ['POST', '/api/surveys/x/gifts/retry'], ['POST', '/api/surveys/x/gifts/release'],
      ['GET', '/api/surveys/x/export/pdf'], ['GET', '/api/surveys/x/export/excel'], ['POST', '/api/surveys/x/sync/google-sheets', {}], ['GET', '/api/surveys/x/not-started.csv'],
      ['POST', '/api/contacts', { name: 'A', phone: '677000000', consent: true }], ['POST', '/api/contacts/bulk-delete', { ids: ['x'] }],
      ['POST', '/api/wallet/topup', { amount: 1000 }], ['POST', '/api/payments/initiate', {}], ['PUT', '/api/subscription/upgrade', { plan: 'starter' }],
      ['POST', '/api/whatsapp/accounts/mock', {}], ['POST', '/api/analytics-bot/link-code'], ['GET', '/api/integrations/google/auth-url'], ['POST', '/api/auth/2fa/setup'],
    ];
    for (const [m, url, body] of gated) {
      const r = await call(m, url, body, asUser(owner.token));
      expect(r.statusCode, `${m} ${url}`).toBe(403);
      expect(json(r).error, `${m} ${url}`).toBe('email_not_verified');
    }
    // What stays open, so the owner can look around and ask for a new link.
    for (const url of ['/api/auth/me', '/api/surveys', '/api/auth/security']) expect((await call('GET', url, undefined, asUser(owner.token))).statusCode, url).toBe(200);
    expect((await call('POST', '/api/auth/verification/resend', undefined, asUser(owner.token))).statusCode).toBe(202);
    // After confirming, the same call is no longer refused for that reason.
    await prisma.user.update({ where: { id: owner.userId }, data: { emailVerifiedAt: new Date() } });
    for (const [m, url, body] of gated.slice(0, 3)) expect(json(await call(m, url, body, asUser(owner.token))).error, `${m} ${url}`).not.toBe('email_not_verified');
  });
});

describe('sign-in (finding 5)', () => {
  it('returns tokens and a safe profile, never a hash or a secret', async () => {
    const { client } = await signUp(app);
    expect(client).toBeTruthy();
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: client!.userId } })).email;
    const r = await login(email);
    expect(r.statusCode).toBe(200);
    const b = json(r);
    expect(b.accessToken.split('.')).toHaveLength(3);
    expect(b.refreshToken).toMatch(/^rt_[A-Za-z0-9]{20,40}_[A-Za-z0-9_-]{40,64}$/);
    expect(b.user).toMatchObject({ email });
    expect(r.body).not.toMatch(/passwordHash|totpSecret|\$argon2|refreshHash/);
    expect((await call('GET', '/api/auth/me', undefined, asUser(b.accessToken))).statusCode).toBe(200);
  });

  it('gives the same answer for a wrong password, an unknown address and an account with no password', async () => {
    await registerOwner(app, { email: 'real@example.com' });
    const { createUserExplore } = await import('../src/routes/auth');
    await createUserExplore({ email: 'google-only@example.com', name: 'G', businessName: 'B', phone: '+237677000009', passwordHash: null, country: 'CM', locale: 'en', emailVerifiedAt: new Date() });
    const answers = await Promise.all([login('real@example.com', 'wrong-password-123'), login('nobody@example.com', 'wrong-password-123'), login('google-only@example.com', 'wrong-password-123')]);
    for (const a of answers) expect(a.statusCode).toBe(401);
    expect(new Set(answers.map((a) => a.body)).size).toBe(1);
    expect(json(answers[0]!)).toMatchObject({ error: 'invalid_credentials', message: 'Invalid email or password' });
  });

  it('tells the owner about a sign-in from a browser or place not seen in 90 days, but not about the first one or a familiar one', async () => {
    const o = await registerOwner(app, { email: 'dev@example.com' });
    expect(o).toBeTruthy();
    const firefox = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0' };
    await login('dev@example.com', TEST_PASSWORD, { 'user-agent': 'vitest' });
    expect(await mailsOf('dev@example.com', 'new_device')).toHaveLength(0);
    await login('dev@example.com', TEST_PASSWORD, firefox);
    const fresh = await mailsOf('dev@example.com', 'new_device');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.text).toContain('Firefox · Windows');
    expect(fresh[0]!.text).not.toMatch(/Mozilla/);
    await login('dev@example.com', TEST_PASSWORD, firefox);
    expect(await mailsOf('dev@example.com', 'new_device')).toHaveLength(1);
    await login('dev@example.com', TEST_PASSWORD, { ...firefox, 'x-sf-country': 'FR' });
    expect(await mailsOf('dev@example.com', 'new_device')).toHaveLength(2); // same browser, another country
  });

  it('writes the sign-in to the owner\'s activity, without the full address or the raw browser string', async () => {
    const o = await registerOwner(app, { email: 'act@example.com' });
    await login('act@example.com', TEST_PASSWORD, { 'x-sf-client-ip': '41.202.207.55', 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36' });
    const rows = await auditRows('login', o.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ipPrefix: '41.202.207.x', userAgent: 'Chrome · Android' });
    expect(JSON.stringify(rows)).not.toContain('41.202.207.55');
    const activity = json(await call('GET', '/api/auth/activity', undefined, asUser(o.token)));
    expect(activity.items.map((i: { action: string }) => i.action)).toContain('login');
  });
});

describe('brute force: rising delays, never a lock-out (finding 5)', () => {
  const ip = (n: number) => ({ 'x-sf-client-ip': `203.0.113.${n}` });

  it('delays double from the fifth failure and are capped at a minute', () => {
    expect([1, 2, 3, 4].map(delaySeconds)).toEqual([0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10, 11, 30].map(delaySeconds)).toEqual([2, 4, 8, 16, 32, 60, 60, 60]);
    expect(PAIR_FREE).toBe(4);
  });

  it('the fifth wrong guess is still answered normally, the sixth attempt has to wait, and even the right password waits', async () => {
    await registerOwner(app, { email: 'b@example.com' });
    for (let i = 0; i < 5; i++) expect((await login('b@example.com', `wrong-guess-${i}-xyz`, ip(1))).statusCode).toBe(401);
    const delayed = await login('b@example.com', 'wrong-again-xyz', ip(1));
    expect(delayed.statusCode).toBe(429);
    expect(json(delayed)).toMatchObject({ error: 'login_delayed', details: { retryAfter: expect.any(Number) } });
    expect(json(delayed).details.retryAfter).toBeLessThanOrEqual(2);
    expect((await login('b@example.com', TEST_PASSWORD, ip(1))).statusCode).toBe(429); // a delay that the right password skips would be no delay
  });

  it('the wait ends by itself, and the next failure doubles it', async () => {
    await registerOwner(app, { email: 'w@example.com' });
    for (let i = 0; i < 5; i++) await login('w@example.com', `wrong-guess-${i}-xyz`, ip(2));
    expect((await login('w@example.com', TEST_PASSWORD, ip(2))).statusCode).toBe(429);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2500);
      expect((await login('w@example.com', 'wrong-guess-6-xyz', ip(2))).statusCode).toBe(401); // allowed again, and fails: now 6 failures, 4 s
      vi.setSystemTime(Date.now() + 1000);
      const r = await login('w@example.com', TEST_PASSWORD, ip(2));
      expect(r.statusCode).toBe(429);
      expect(json(r).details.retryAfter).toBeGreaterThan(2);
      vi.setSystemTime(Date.now() + 4500);
      expect((await login('w@example.com', TEST_PASSWORD, ip(2))).statusCode).toBe(200);
    } finally { vi.useRealTimers(); }
  });

  it('is per address AND per connection: a stranger guessing from elsewhere does not slow the owner on their usual connection', async () => {
    await registerOwner(app, { email: 'o@example.com' });
    for (let i = 0; i < 6; i++) await login('o@example.com', `wrong-guess-${i}-xyz`, ip(3));
    expect((await login('o@example.com', 'wrong-guess-x-xyz', ip(3))).statusCode).toBe(429);
    expect((await login('o@example.com', TEST_PASSWORD, ip(4))).statusCode).toBe(200); // the owner, from another connection
    expect((await login('someone-else@example.com', 'whatever-123456', ip(3))).statusCode).toBe(401); // the same IP, another address: its own budget
  });

  it('cannot be dodged by spelling the address differently', async () => {
    const { createUserExplore } = await import('../src/routes/auth');
    const { hashPassword } = await import('../src/lib/password');
    await createUserExplore({ email: 'john.doe@gmail.com', name: 'J', businessName: 'B', phone: '+237677000011', passwordHash: await hashPassword(TEST_PASSWORD), country: 'CM', locale: 'en', emailVerifiedAt: new Date() });
    const spellings = ['john.doe@gmail.com', 'johndoe@gmail.com', 'JOHN.DOE@gmail.com', 'j.o.h.n.d.o.e@gmail.com', 'johndoe+1@gmail.com'];
    for (const s of spellings) expect((await login(s, 'wrong-guess-xyz-1', ip(5))).statusCode).toBe(401);
    expect((await login('john.doe+2@gmail.com', 'wrong-guess-xyz-2', ip(5))).statusCode).toBe(429);
  });

  it('the per-minute cap on credential calls is per mailbox too: aliases of one address share one allowance', () => {
    const key = (email: string, ip = '203.0.113.9') => rlCredentials(10).config.rateLimit.keyGenerator({ body: { email }, headers: {}, socket: { remoteAddress: ip } } as never);
    const keys = new Set(['john.doe@gmail.com', 'J.O.H.N.DOE@gmail.com', 'johndoe+shop@gmail.com', 'johndoe@googlemail.com', ' JohnDoe@Gmail.com '].map((e) => key(e)));
    expect(keys.size).toBe(1);
    expect(key('other@gmail.com')).not.toBe(key('john.doe@gmail.com'));
    expect(key('john.doe@gmail.com', '198.51.100.7')).not.toBe(key('john.doe@gmail.com')); // and still per connection
    expect(key('a.b@corp.example')).not.toBe(key('ab@corp.example')); // unknown domains are not folded: that could be two different people
  });

  it('a successful sign-in forgives the earlier failures of that address from that connection', async () => {
    await registerOwner(app, { email: 'f@example.com' });
    for (let i = 0; i < 4; i++) await login('f@example.com', `wrong-guess-${i}-xyz`, ip(6));
    expect((await login('f@example.com', TEST_PASSWORD, ip(6))).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login('f@example.com', `wrong-guess-${i}-xyz`, ip(6))).statusCode, `attempt ${i}`).toBe(401);
  });

  it('many wrong guesses spread over many connections: a CAPTCHA for everybody and ONE alert e-mail to the owner', async () => {
    await registerOwner(app, { email: 'spread@example.com' });
    for (let i = 0; i < 12; i++) await login('spread@example.com', `wrong-guess-${i}-xyz`, ip(10 + i));
    const alerts = await mailsOf('spread@example.com', 'failed_logins');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toMatch(/10/);
    const g = await checkLoginGuard('spread@example.com', '198.51.100.99');
    expect(g).toMatchObject({ captchaRequired: true, retryAfter: 0 });
    expect(g.accountFailures).toBeGreaterThanOrEqual(10);
    expect(await auditRows('login_blocked')).toHaveLength(1);
  });

  it('asks for the CAPTCHA once it is needed and refuses a missing or failed one, but a service outage does not lock everybody out', async () => {
    const saved = { enabled: env.captchaEnabled, secret: env.TURNSTILE_SECRET_KEY, site: env.TURNSTILE_SITE_KEY };
    env.captchaEnabled = true; env.TURNSTILE_SECRET_KEY = 'turnstile-secret'; env.TURNSTILE_SITE_KEY = 'site-key';
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: URLSearchParams }) => new Response(JSON.stringify({ success: init?.body?.get('response') === 'good-token' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await registerOwner(app, { email: 'c@example.com' });
      expect(json(await call('GET', '/api/auth/config')).captcha).toEqual({ provider: 'turnstile', siteKey: 'site-key' });
      expect((await login('c@example.com', TEST_PASSWORD, ip(30))).statusCode).toBe(200); // no CAPTCHA while nothing is wrong
      for (let i = 0; i < 5; i++) await login('c@example.com', `wrong-guess-${i}-xyz`, ip(31)); // five failures: delays and CAPTCHA from now on
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 3000);
      const missing = await login('c@example.com', TEST_PASSWORD, ip(31));
      expect(missing.statusCode).toBe(403);
      expect(json(missing)).toMatchObject({ error: 'captcha_required', details: { captcha: true } });
      expect((await login('c@example.com', TEST_PASSWORD, ip(31), { captchaToken: 'bad-token' })).statusCode).toBe(403);
      expect((await login('c@example.com', TEST_PASSWORD, ip(31), { captchaToken: 'good-token' })).statusCode).toBe(200);
      const verifyCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('turnstile'));
      expect(String(verifyCall![0])).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      expect(verifyCall![1]!.body!.get('secret')).toBe('turnstile-secret');
      vi.useRealTimers();

      // Sign-up and "forgot password" always need it while it is configured.
      expect(json(await register('nocaptcha@example.com')).error).toBe('captcha_failed');
      expect((await register('captcha@example.com', { captchaToken: 'good-token' })).statusCode).toBe(202);
      expect(json(await call('POST', '/api/auth/password/forgot', { email: 'c@example.com' })).error).toBe('captcha_failed');

      // Cloudflare unreachable: the delays still protect, so nobody is locked out by somebody else's outage.
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await verifyCaptcha('anything', '203.0.113.1')).toBe(true);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
      expect(await verifyCaptcha(undefined)).toBe(false);
      expect(await verifyCaptcha('x'.repeat(5000))).toBe(false);
    } finally {
      vi.useRealTimers(); vi.unstubAllGlobals();
      env.captchaEnabled = saved.enabled; env.TURNSTILE_SECRET_KEY = saved.secret; env.TURNSTILE_SITE_KEY = saved.site;
    }
  });

  it('with no CAPTCHA configured (development, the shared demo) everything is allowed through', async () => {
    expect(await verifyCaptcha(undefined)).toBe(true);
    expect((await register('nocap@example.com')).statusCode).toBe(202);
  });
});

describe('sessions (finding 3)', () => {
  it('every sign-in is a session row; the refresh token is stored hashed and the address only as a coarse prefix', async () => {
    const o = await registerOwner(app, { email: 's@example.com' });
    const r = json(await login('s@example.com', TEST_PASSWORD, { 'x-sf-client-ip': '41.202.207.55' }));
    const row = await prisma.authSession.findUniqueOrThrow({ where: { id: r.sessionId } });
    expect(row.userId).toBe(o.userId);
    expect(row.refreshHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.refreshToken).not.toContain(row.refreshHash);
    expect(row.refreshHash).toBe(createHash('sha256').update(r.refreshToken.split('_').slice(2).join('_')).digest('hex'));
    expect(row.ipPrefix).toBe('41.202.207.x');
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(11.9 * 3_600_000);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(12 * 3_600_000);
  });

  it('signing out ends the session at once, even while the API token has minutes left', async () => {
    await registerOwner(app, { email: 'l@example.com' });
    const t = json(await login('l@example.com')).accessToken;
    expect((await call('GET', '/api/auth/me', undefined, asUser(t))).statusCode).toBe(200); // warms the cache
    expect((await call('POST', '/api/auth/logout', undefined, asUser(t))).statusCode).toBe(204);
    const after = await call('GET', '/api/auth/me', undefined, asUser(t));
    expect(after.statusCode).toBe(401);
    expect(json(after).message).toBe('Session ended');
    expect(await auditRows('logout')).toHaveLength(1);
  });

  it('lists the owner\'s open sessions, marks this one, and lets one be ended without touching the others', async () => {
    const o = await registerOwner(app, { email: 'list@example.com' });
    const a = json(await login('list@example.com', TEST_PASSWORD, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36' }));
    const b = json(await login('list@example.com', TEST_PASSWORD, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1' }));
    const list = json(await call('GET', '/api/auth/sessions', undefined, asUser(a.accessToken)));
    expect(list.items.length).toBeGreaterThanOrEqual(3); // the one registerOwner made, plus these two
    expect(list.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(list.items.find((s: { id: string }) => s.id === a.sessionId).current).toBe(true);
    expect(list.items.find((s: { id: string }) => s.id === b.sessionId).device).toBe('Safari · iOS');
    expect(JSON.stringify(list)).not.toMatch(/refreshHash|prevRefreshHash/);

    expect((await call('DELETE', `/api/auth/sessions/${b.sessionId}`, undefined, asUser(a.accessToken))).statusCode).toBe(204);
    expect((await call('GET', '/api/auth/me', undefined, asUser(b.accessToken))).statusCode).toBe(401);
    expect((await call('GET', '/api/auth/me', undefined, asUser(a.accessToken))).statusCode).toBe(200);

    const other = await registerOwner(app, { email: 'other@example.com' });
    const theirs = json(await login('other@example.com'));
    expect((await call('DELETE', `/api/auth/sessions/${theirs.sessionId}`, undefined, asUser(a.accessToken))).statusCode).toBe(404); // not yours
    expect((await call('GET', '/api/auth/me', undefined, asUser(theirs.accessToken))).statusCode).toBe(200);
    expect(o.userId).not.toBe(other.userId);
  });

  it('"sign out everywhere" ends every session (or every other one) and tells the owner by e-mail', async () => {
    await registerOwner(app, { email: 'all@example.com' });
    const a = json(await login('all@example.com'));
    const b = json(await login('all@example.com'));
    const c = json(await login('all@example.com'));
    expect(json(await call('POST', '/api/auth/sessions/revoke-all', { scope: 'others' }, asUser(a.accessToken))).revoked).toBeGreaterThanOrEqual(2);
    expect((await call('GET', '/api/auth/me', undefined, asUser(a.accessToken))).statusCode).toBe(200);
    expect((await call('GET', '/api/auth/me', undefined, asUser(b.accessToken))).statusCode).toBe(401);
    expect((await call('GET', '/api/auth/me', undefined, asUser(c.accessToken))).statusCode).toBe(401);
    expect(await mailsOf('all@example.com', 'sessions_revoked')).toHaveLength(1);
    expect(json(await call('POST', '/api/auth/sessions/revoke-all', {}, asUser(a.accessToken))).revoked).toBe(1);
    expect((await call('GET', '/api/auth/me', undefined, asUser(a.accessToken))).statusCode).toBe(401);
  });

  it('a session past its life, or whose account was deleted, ends the token', async () => {
    await registerOwner(app, { email: 'x1@example.com' });
    const a = json(await login('x1@example.com'));
    await call('GET', '/api/auth/me', undefined, asUser(a.accessToken));
    await prisma.authSession.update({ where: { id: a.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await redis.del(`sf:sess:${a.sessionId}`);
    expect((await call('GET', '/api/auth/me', undefined, asUser(a.accessToken))).statusCode).toBe(401);

    const o = await registerOwner(app, { email: 'x2@example.com' });
    const b = json(await login('x2@example.com'));
    await prisma.user.delete({ where: { id: o.userId } });
    await redis.del(`sf:sess:${b.sessionId}`);
    expect((await call('GET', '/api/auth/me', undefined, asUser(b.accessToken))).statusCode).toBe(401);
  });

  it('an API token never outlives its session, whatever the configured lifetime', async () => {
    await registerOwner(app, { email: 'ttl@example.com' });
    const a = json(await login('ttl@example.com'));
    const claims = JSON.parse(Buffer.from(a.accessToken.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'surveyflow', aud: 'surveyflow-api', sid: a.sessionId });
    expect(claims.exp - claims.iat).toBe(env.ACCESS_TOKEN_TTL_SECONDS);
    const header = JSON.parse(Buffer.from(a.accessToken.split('.')[0], 'base64url').toString());
    expect(header).toMatchObject({ alg: 'HS256', kid: expect.stringMatching(/^[0-9a-f]{8}$/) });
  });
});

describe('API tokens', () => {
  const key = (secret: string) => new TextEncoder().encode(secret);
  const kid = (secret: string) => createHash('sha256').update(secret).digest('hex').slice(0, 8);
  const forge = (over: { secret?: string; aud?: string; iss?: string; sid?: string | null; sub?: string; exp?: string | number; alg?: 'HS256' | 'HS512'; kid?: string }) => {
    const secret = over.secret ?? env.jwtSecret;
    return new SignJWT(over.sid === null ? {} : { sid: over.sid ?? 'x' })
      .setProtectedHeader({ alg: over.alg ?? 'HS256', kid: over.kid ?? kid(secret) })
      .setSubject(over.sub ?? 'someone').setIssuer(over.iss ?? 'surveyflow').setAudience(over.aud ?? 'surveyflow-api').setIssuedAt().setExpirationTime(over.exp ?? '10m')
      .sign(key(secret));
  };

  it('refuses a forged, foreign, expired or old-style token', async () => {
    const o = await registerOwner(app, { email: 'tok@example.com' });
    const real = json(await login('tok@example.com'));
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: kid(env.jwtSecret) })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: o.userId, sid: real.sessionId, iss: 'surveyflow', aud: 'surveyflow-api', exp: 9999999999 })).toString('base64url')}.`;
    const bad = [
      await forge({ secret: 'another-secret-another-secret-another-secret', sub: o.userId, sid: real.sessionId }),
      await forge({ sub: o.userId, sid: real.sessionId, aud: 'surveyflow-state' }),
      await forge({ sub: o.userId, sid: real.sessionId, iss: 'someone-else' }),
      await forge({ sub: o.userId, sid: real.sessionId, alg: 'HS512' }),
      await forge({ sub: o.userId, sid: real.sessionId, kid: 'deadbeef' }),
      await forge({ sub: o.userId, sid: real.sessionId, exp: Math.floor(Date.now() / 1000) - 60 }),
      await forge({ sub: o.userId, sid: null }), // the previous format had no session: it must not be honoured
      await forge({ sub: o.userId, sid: 'a-session-that-does-not-exist' }),
      unsigned, 'not-a-token', '',
    ];
    for (const t of bad) expect((await call('GET', '/api/auth/me', undefined, t ? asUser(t) : {})).statusCode, t.slice(0, 40)).toBe(401);
    expect((await call('GET', '/api/auth/me', undefined, { authorization: real.accessToken })).statusCode).toBe(401); // no "Bearer "
    expect((await call('GET', '/api/auth/me', undefined, asUser(real.accessToken))).statusCode).toBe(200);
  });

  it('a valid token for a session that belongs to somebody else is refused', async () => {
    const a = await registerOwner(app, { email: 'ta@example.com' });
    await registerOwner(app, { email: 'tb@example.com' });
    const b = json(await login('tb@example.com'));
    const crossed = await signAccessToken(a.userId, b.sessionId);
    expect((await call('GET', '/api/auth/me', undefined, asUser(crossed.token))).statusCode).toBe(401);
  });

  it('signing secrets rotate without signing anybody out: the previous one still verifies until it is dropped', async () => {
    const A = 'secret-A-secret-A-secret-A-secret-A-1234';
    const B = 'secret-B-secret-B-secret-B-secret-B-5678';
    const load = async (over: Record<string, string>) => {
      const saved: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v; }
      vi.resetModules();
      try { return await import('../src/lib/jwt'); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    };
    const before = await load({ JWT_SECRET: A, JWT_SECRET_PREVIOUS: '' });
    const old = (await before.signAccessToken('u1', 's1')).token;
    const during = await load({ JWT_SECRET: B, JWT_SECRET_PREVIOUS: A });
    expect(await during.verifyAccessToken(old)).toEqual({ userId: 'u1', sessionId: 's1' });
    const fresh = (await during.signAccessToken('u2', 's2')).token;
    expect(JSON.parse(Buffer.from(fresh.split('.')[0]!, 'base64url').toString()).kid).toBe(kid(B));
    const after = await load({ JWT_SECRET: B, JWT_SECRET_PREVIOUS: '' });
    await expect(after.verifyAccessToken(old)).rejects.toThrow();
    expect(await after.verifyAccessToken(fresh)).toEqual({ userId: 'u2', sessionId: 's2' });
  });
});

describe('refresh tokens (finding 3)', () => {
  const refresh = (rt: string) => call('POST', '/api/auth/refresh', { refreshToken: rt });
  const fresh = async (email = 'rf@example.com') => { await registerOwner(app, { email }); return json(await login(email)); };

  it('trades the refresh token for a new API token and a NEW refresh token; the access token works', async () => {
    const a = await fresh();
    const r = await refresh(a.refreshToken);
    expect(r.statusCode).toBe(200);
    const b = json(r);
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.refreshToken).not.toBe(a.refreshToken);
    expect((await call('GET', '/api/auth/me', undefined, asUser(b.accessToken))).statusCode).toBe(200);
    expect((await refresh(b.refreshToken)).statusCode).toBe(200); // and the new one rotates again
  });

  it('two requests refreshing at the same moment are not theft: both get an API token and exactly one gets the new refresh token', async () => {
    const a = await fresh();
    const results = await Promise.all([refresh(a.refreshToken), refresh(a.refreshToken), refresh(a.refreshToken)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const bodies = results.map(json);
    const winners = bodies.filter((b) => b.refreshToken !== null);
    expect(winners).toHaveLength(1);
    expect((await refresh(winners[0].refreshToken)).statusCode).toBe(200);
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: a.sessionId } })).revokedAt).toBeNull();
  });

  it('the previous token is honoured for a short grace period, with a fresh API token but without a new refresh token', async () => {
    const a = await fresh();
    const b = json(await refresh(a.refreshToken));
    const again = json(await refresh(a.refreshToken)); // a parallel tab that read the old cookie
    expect(again.refreshToken).toBeNull();
    expect((await call('GET', '/api/auth/me', undefined, asUser(again.accessToken))).statusCode).toBe(200);
    expect((await refresh(b.refreshToken)).statusCode).toBe(200); // the winner's token is the live one
  });

  it('an old token used after the grace period means the cookie was copied: the whole session ends', async () => {
    const a = await fresh();
    const b = json(await refresh(a.refreshToken));
    await prisma.authSession.update({ where: { id: a.sessionId }, data: { rotatedAt: new Date(Date.now() - 31_000) } });
    const replay = await refresh(a.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect((await refresh(b.refreshToken)).statusCode).toBe(401); // the thief and the owner are both out
    expect((await call('GET', '/api/auth/me', undefined, asUser(b.accessToken))).statusCode).toBe(401);
    const row = await prisma.authSession.findUniqueOrThrow({ where: { id: a.sessionId } });
    expect(row.revokedReason).toBe('refresh_reuse');
    expect(await auditRows('refresh_reuse')).toHaveLength(1);
  });

  it('refuses malformed, unknown, tampered, revoked and expired ones the same way', async () => {
    const a = await fresh();
    const [, sid, secret] = /^rt_([A-Za-z0-9]+)_(.+)$/.exec(a.refreshToken)!;
    for (const rt of ['', 'nonsense', `rt_${sid}_${'A'.repeat(48)}`, `rt_${'x'.repeat(25)}_${secret}`, a.refreshToken.slice(0, -1) + (a.refreshToken.endsWith('A') ? 'B' : 'A')]) {
      const r = await refresh(rt);
      expect([400, 401], rt).toContain(r.statusCode);
    }
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: a.sessionId } })).revokedAt).not.toBeNull(); // a wrong secret for a real session is treated as a replay

    const b = await fresh('rf2@example.com');
    await call('POST', '/api/auth/logout', undefined, asUser(b.accessToken));
    expect((await refresh(b.refreshToken)).statusCode).toBe(401);

    const c = await fresh('rf3@example.com');
    await prisma.authSession.update({ where: { id: c.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await refresh(c.refreshToken)).statusCode).toBe(401);
  });

  it('the website signs somebody out with the refresh token alone, once the API token has expired; a wrong secret ends nothing', async () => {
    const signout = (rt: string) => call('POST', '/api/auth/signout', { refreshToken: rt });
    const a = await fresh('so1@example.com');
    const [, sid] = /^rt_([A-Za-z0-9]+)_/.exec(a.refreshToken)!;
    for (const wrong of ['nonsense', `rt_${sid}_${'A'.repeat(48)}`, `rt_${'x'.repeat(25)}_${'A'.repeat(48)}`]) expect((await signout(wrong)).statusCode, wrong).toBe(204);
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: a.sessionId } })).revokedAt).toBeNull(); // nobody can sign others out by guessing
    expect((await call('GET', '/api/auth/me', undefined, asUser(a.accessToken))).statusCode).toBe(200);

    expect((await signout(a.refreshToken)).statusCode).toBe(204);
    expect((await call('GET', '/api/auth/me', undefined, asUser(a.accessToken))).statusCode).toBe(401);
    expect((await refresh(a.refreshToken)).statusCode).toBe(401);
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: a.sessionId } })).revokedReason).toBe('logout');
    expect(await auditRows('logout')).toHaveLength(1);
    expect((await signout(a.refreshToken)).statusCode).toBe(204); // already over: still the same answer

    const b = await fresh('so2@example.com');
    const rotated = json(await refresh(b.refreshToken));
    expect((await signout(b.refreshToken)).statusCode).toBe(204); // the previous token (a parallel tab) still proves the session
    expect((await refresh(rotated.refreshToken)).statusCode).toBe(401);
  });

  it('a refresh token is not an API token', async () => {
    const a = await fresh();
    expect((await call('GET', '/api/auth/me', undefined, asUser(a.refreshToken))).statusCode).toBe(401);
  });
});

describe('forgotten and changed passwords', () => {
  it('"forgot" answers the same for any address and mails only a real one; a newer link replaces the older; there are three a hour', async () => {
    await registerOwner(app, { email: 'fg@example.com' });
    const unknown = await call('POST', '/api/auth/password/forgot', { email: 'nobody@example.com' });
    const known = await call('POST', '/api/auth/password/forgot', { email: 'fg@example.com' });
    expect([unknown.statusCode, known.statusCode]).toEqual([202, 202]);
    expect(unknown.body).toBe(known.body);
    expect(await mailsOf('nobody@example.com')).toHaveLength(0);
    const first = (await tokenIn('fg@example.com', 'reset_password'))!;
    await call('POST', '/api/auth/password/forgot', { email: 'FG@example.com' });
    const second = (await tokenIn('fg@example.com', 'reset_password'))!;
    expect(second).not.toBe(first);
    expect(json(await call('POST', '/api/auth/password/reset', { token: first, password: 'a-brand-new-password-77' })).error).toBe('invalid_token');
    for (let i = 0; i < 5; i++) await call('POST', '/api/auth/password/forgot', { email: 'fg@example.com' });
    expect(await mailsOf('fg@example.com', 'reset_password')).toHaveLength(3);
  });

  it('a reset sets the password, works once, ends every session, confirms the address and tells the owner', async () => {
    const o = await registerOwner(app, { email: 'rs@example.com', verified: false });
    const s = json(await login('rs@example.com'));
    await call('POST', '/api/auth/password/forgot', { email: 'rs@example.com' });
    const token = (await tokenIn('rs@example.com', 'reset_password'))!;
    const NEW = 'a-brand-new-password-77';
    expect((await call('POST', '/api/auth/password/reset', { token, password: NEW })).statusCode).toBe(200);
    expect((await call('POST', '/api/auth/password/reset', { token, password: 'yet-another-password-88' })).statusCode).toBe(400); // used up
    expect((await call('GET', '/api/auth/me', undefined, asUser(s.accessToken))).statusCode).toBe(401);
    expect((await login('rs@example.com', TEST_PASSWORD)).statusCode).toBe(401);
    expect((await login('rs@example.com', NEW)).statusCode).toBe(200);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: o.userId } });
    expect(u.emailVerifiedAt).not.toBeNull(); // reading the link proved the mailbox
    expect(u.passwordChangedAt).not.toBeNull();
    expect(await mailsOf('rs@example.com', 'password_changed')).toHaveLength(1);
    expect(await auditRows('password_reset', o.userId)).toHaveLength(1);
  });

  it('a weak new password does not use up the link', async () => {
    await registerOwner(app, { email: 'wk@example.com' });
    await call('POST', '/api/auth/password/forgot', { email: 'wk@example.com' });
    const token = (await tokenIn('wk@example.com', 'reset_password'))!;
    const weak = await call('POST', '/api/auth/password/reset', { token, password: 'password123' });
    expect(weak.statusCode).toBe(400);
    expect(json(weak).error).toBe('password_too_common');
    expect((await call('POST', '/api/auth/password/reset', { token, password: 'a-brand-new-password-77' })).statusCode).toBe(200);
  });

  it('an expired link is refused', async () => {
    await registerOwner(app, { email: 'ex@example.com' });
    await call('POST', '/api/auth/password/forgot', { email: 'ex@example.com' });
    const token = (await tokenIn('ex@example.com', 'reset_password'))!;
    await prisma.emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(json(await call('POST', '/api/auth/password/reset', { token, password: 'a-brand-new-password-77' })).error).toBe('invalid_token');
  });

  it('changing it while signed in needs the current one, ends the other sessions and keeps this one', async () => {
    await registerOwner(app, { email: 'ch@example.com' });
    const here = json(await login('ch@example.com'));
    const there = json(await login('ch@example.com'));
    const NEW = 'a-brand-new-password-77';
    const h = asUser(here.accessToken);
    expect(json(await call('POST', '/api/auth/password/change', { currentPassword: 'wrong-current-pass', newPassword: NEW }, h)).error).toBe('invalid_credentials');
    expect(json(await call('POST', '/api/auth/password/change', { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD }, h)).error).toBe('password_unchanged');
    expect(json(await call('POST', '/api/auth/password/change', { currentPassword: TEST_PASSWORD, newPassword: 'password123' }, h)).error).toBe('password_too_common');
    const ok = await call('POST', '/api/auth/password/change', { currentPassword: TEST_PASSWORD, newPassword: NEW }, h);
    expect(ok.statusCode).toBe(200);
    expect(json(ok).sessionsEnded).toBeGreaterThanOrEqual(2);
    expect((await call('GET', '/api/auth/me', undefined, h)).statusCode).toBe(200);
    expect((await call('GET', '/api/auth/me', undefined, asUser(there.accessToken))).statusCode).toBe(401);
    expect((await login('ch@example.com', TEST_PASSWORD)).statusCode).toBe(401);
    expect((await login('ch@example.com', NEW)).statusCode).toBe(200);
    expect(await mailsOf('ch@example.com', 'password_changed')).toHaveLength(1);
  });

  it('an account created with the older bcrypt hash signs in and is moved to argon2id', async () => {
    const o = await registerOwner(app, { email: 'bc@example.com' });
    const bcrypt = (await import('bcryptjs')).default;
    await prisma.user.update({ where: { id: o.userId }, data: { passwordHash: await bcrypt.hash(TEST_PASSWORD, 4) } });
    expect((await login('bc@example.com', 'wrong-password-123')).statusCode).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).passwordHash).toMatch(/^\$2[aby]\$/);
    expect((await login('bc@example.com')).statusCode).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).passwordHash).toMatch(/^\$argon2id\$/);
    expect((await login('bc@example.com')).statusCode).toBe(200);
  });
});

afterEach(() => { vi.useRealTimers(); });
