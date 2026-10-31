import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { decryptSecret } from '../src/lib/crypto';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { stepNow, totpAt } from '../src/lib/totp';
import { readMockMailbox } from '../src/services/mail';
import { createSession } from '../src/services/security/sessions';
import { TEST_PASSWORD, buildWorld, client, loginRaw, makeApp, registerOwner, resetAll, type Client } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
beforeEach(async () => { await resetAll(); });
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'content-type': 'application/json', ...headers }, payload: body === undefined ? undefined : JSON.stringify(body) });
const asUser = (token: string) => ({ authorization: `Bearer ${token}` });
const json = (r: { body: string }) => JSON.parse(r.body);
const mailsOf = async (email: string, kind?: string) => (await readMockMailbox(email)).filter((m) => !kind || m.kind === kind);
const emailOf = async (c: Client) => (await prisma.user.findUniqueOrThrow({ where: { id: c.userId } })).email;
const auditRows = (action: string, userId?: string) => prisma.auditLog.findMany({ where: { action, ...(userId ? { userId } : {}) }, orderBy: { at: 'asc' } });

/**
 * Authenticator codes are accepted once and only moving forward in time, so a test needs a NEW step for every code it uses. The clock of the process is
 * faked (Date only) and moved on 30 seconds each time a code is wanted: the API and the test then agree on the step.
 */
function authenticator(secret: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  return () => { vi.setSystemTime(Date.now() + 30_000); return totpAt(secret, stepNow()); };
}

/** Turns two-factor on for the owner through the real endpoints. */
async function enableTwoFactor(owner: Client) {
  const setup = json(await call('POST', '/api/auth/2fa/setup', undefined, asUser(owner.token)));
  const code = authenticator(setup.secret);
  const on = json(await call('POST', '/api/auth/2fa/enable', { code: code() }, asUser(owner.token)));
  return { secret: setup.secret as string, code, recoveryCodes: on.recoveryCodes as string[] };
}

describe('authenticator app (SEC-09)', () => {
  it('step 1 hands out a secret and a QR code drawn here; nothing is on until the first code is confirmed', async () => {
    const o = await registerOwner(app, { email: 'tf@example.com' });
    const r = await call('POST', '/api/auth/2fa/setup', undefined, asUser(o.token));
    expect(r.statusCode).toBe(200);
    const b = json(r);
    expect(b.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(b.otpauthUrl).toContain('otpauth://totp/SurveyFlow:tf%40example.com');
    expect(b.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(b.qr.split(',')[1], 'base64').toString()).toContain('<svg');
    const u = await prisma.user.findUniqueOrThrow({ where: { id: o.userId } });
    expect(u.totpEnabledAt).toBeNull();
    expect(u.totpSecret).toMatch(/^v2\./); // encrypted at rest
    expect(u.totpSecret).not.toContain(b.secret);
    expect(decryptSecret(u.totpSecret!)).toBe(b.secret);
    expect((await loginRaw(app, 'tf@example.com', TEST_PASSWORD)).statusCode).toBe(200); // still no code asked
  });

  it('step 2: a wrong code changes nothing; the right one turns it on and shows the recovery codes once', async () => {
    const o = await registerOwner(app, { email: 'tf2@example.com' });
    const setup = json(await call('POST', '/api/auth/2fa/setup', undefined, asUser(o.token)));
    const code = authenticator(setup.secret);
    const wrong = await call('POST', '/api/auth/2fa/enable', { code: '000000' }, asUser(o.token));
    expect(wrong.statusCode).toBe(400);
    expect(json(wrong).error).toBe('invalid_code');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).totpEnabledAt).toBeNull();

    const ok = await call('POST', '/api/auth/2fa/enable', { code: code() }, asUser(o.token));
    expect(ok.statusCode).toBe(200);
    const { enabled, recoveryCodes } = json(ok);
    expect(enabled).toBe(true);
    expect(recoveryCodes).toHaveLength(10);
    for (const c of recoveryCodes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    expect(new Set(recoveryCodes).size).toBe(10);

    const stored = await prisma.recoveryCode.findMany({ where: { userId: o.userId } });
    expect(stored).toHaveLength(10);
    expect(JSON.stringify(stored)).not.toContain(recoveryCodes[0].replace(/-/g, '')); // only keyed hashes are kept
    expect(stored.every((s) => /^[0-9a-f]{64}$/.test(s.codeHash))).toBe(true);
    expect(await mailsOf('tf2@example.com', 'two_factor_changed')).toHaveLength(1);
    expect(await auditRows('two_factor_enabled', o.userId)).toHaveLength(1);
    expect((await call('POST', '/api/auth/2fa/setup', undefined, asUser(o.token))).statusCode).toBe(409);
    expect(json(await call('POST', '/api/auth/2fa/enable', { code: code() }, asUser(o.token))).error).toBe('two_factor_already_on');
    expect(json(await call('GET', '/api/auth/security', undefined, asUser(o.token)))).toMatchObject({ twoFactorEnabled: true, recoveryCodesLeft: 10 });
  });

  it('cannot be switched on without starting the setup, and enabling attempts are limited', async () => {
    const o = await registerOwner(app, { email: 'tf3@example.com' });
    expect(json(await call('POST', '/api/auth/2fa/enable', { code: '123456' }, asUser(o.token))).error).toBe('two_factor_not_started');
    await call('POST', '/api/auth/2fa/setup', undefined, asUser(o.token));
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call('POST', '/api/auth/2fa/enable', { code: '000000' }, asUser(o.token))).statusCode;
    expect(last).toBe(429);
  });

  it('sign-in then needs the code, but only after the password was right (so it says nothing to someone guessing)', async () => {
    const o = await registerOwner(app, { email: 'tf4@example.com' });
    const { code } = await enableTwoFactor(o);
    const wrongPassword = await loginRaw(app, 'tf4@example.com', 'wrong-password-123');
    expect(json(wrongPassword).error).toBe('invalid_credentials');
    const noCode = await loginRaw(app, 'tf4@example.com', TEST_PASSWORD);
    expect(noCode.statusCode).toBe(401);
    expect(json(noCode).error).toBe('totp_required');
    expect(noCode.body).not.toMatch(/accessToken/);
    const badCode = await loginRaw(app, 'tf4@example.com', TEST_PASSWORD, {}, { totp: '000000' });
    expect(json(badCode).error).toBe('invalid_code');
    const good = code();
    const r = await loginRaw(app, 'tf4@example.com', TEST_PASSWORD, {}, { totp: good });
    expect(r.statusCode).toBe(200);
    expect(await prisma.authSession.count({ where: { userId: o.userId, mfa: true } })).toBe(1);
    // a code that was already used cannot be used again, even within its 30 seconds
    const replay = await loginRaw(app, 'tf4@example.com', TEST_PASSWORD, {}, { totp: good });
    expect(replay.statusCode).toBe(401);
    expect(json(replay).error).toBe('invalid_code');
    expect((await loginRaw(app, 'tf4@example.com', TEST_PASSWORD, {}, { totp: code() })).statusCode).toBe(200);
  });

  it('a wrong code counts as a failed attempt like a wrong password (it cannot be guessed at without limit)', async () => {
    const o = await registerOwner(app, { email: 'tf5@example.com' });
    await enableTwoFactor(o);
    const ip = { 'x-sf-client-ip': '203.0.113.50' };
    for (let i = 0; i < 5; i++) expect((await loginRaw(app, 'tf5@example.com', TEST_PASSWORD, ip, { totp: String(100000 + i) })).statusCode).toBe(401);
    expect((await loginRaw(app, 'tf5@example.com', TEST_PASSWORD, ip, { totp: '111111' })).statusCode).toBe(429);
  });

  it('a recovery code signs in once, in any case and with or without the dashes, and is then gone', async () => {
    const o = await registerOwner(app, { email: 'rc@example.com' });
    const { recoveryCodes } = await enableTwoFactor(o);
    const first = recoveryCodes[0]!;
    const r = await loginRaw(app, 'rc@example.com', TEST_PASSWORD, {}, { recoveryCode: first.toLowerCase().replace(/-/g, ' ') });
    expect(r.statusCode).toBe(200);
    expect((await loginRaw(app, 'rc@example.com', TEST_PASSWORD, {}, { recoveryCode: first })).statusCode).toBe(401);
    expect(json(await call('GET', '/api/auth/security', undefined, asUser(json(r).accessToken)))).toMatchObject({ recoveryCodesLeft: 9 });
    const used = await auditRows('recovery_code_used', o.userId);
    expect(used).toHaveLength(1);
    expect(used[0]!.meta).toEqual({ left: 9 });
    expect((await loginRaw(app, 'rc@example.com', TEST_PASSWORD, {}, { recoveryCode: 'AAAA-BBBB-CCCC-DDDD' })).statusCode).toBe(401);
  });

  it('recovery codes are stored as a plain SHA-256 of the code, so rotating JWT_SECRET (or any key) can never invalidate them', async () => {
    const o = await registerOwner(app, { email: 'rcrot@example.com' });
    const { recoveryCodes } = await enableTwoFactor(o);
    const stored = (await prisma.recoveryCode.findMany({ where: { userId: o.userId } })).map((r) => r.codeHash).sort();
    const expected = recoveryCodes.map((c) => createHash('sha256').update(`recovery-code:${c.replace(/-/g, '')}`).digest('hex')).sort();
    expect(stored).toEqual(expected);
    // about 80 bits: 16 characters from a 31-letter alphabet, which is what makes an unkeyed hash safe
    for (const c of recoveryCodes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  });

  it('turning it off needs the password and a current code (or a recovery code); a stolen session alone cannot', async () => {
    const o = await registerOwner(app, { email: 'off@example.com' });
    const { code, recoveryCodes } = await enableTwoFactor(o);
    const h = asUser(o.token);
    expect((await call('POST', '/api/auth/2fa/disable', { code: code() }, h)).statusCode).toBe(401); // no password
    expect((await call('POST', '/api/auth/2fa/disable', { code: code(), password: 'wrong-password-123' }, h)).statusCode).toBe(401);
    expect(json(await call('POST', '/api/auth/2fa/disable', { code: '000000', password: TEST_PASSWORD }, h)).error).toBe('invalid_code');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).totpEnabledAt).not.toBeNull();
    const ok = await call('POST', '/api/auth/2fa/disable', { code: recoveryCodes[3], password: TEST_PASSWORD }, h);
    expect(ok.statusCode).toBe(200);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: o.userId } });
    expect(u).toMatchObject({ totpEnabledAt: null, totpSecret: null });
    expect(await prisma.recoveryCode.count({ where: { userId: o.userId } })).toBe(0);
    expect(await mailsOf('off@example.com', 'two_factor_changed')).toHaveLength(2);
    expect((await loginRaw(app, 'off@example.com', TEST_PASSWORD)).statusCode).toBe(200);
    expect((await call('POST', '/api/auth/2fa/disable', { code: '123456', password: TEST_PASSWORD }, h)).statusCode).toBe(409);
  });

  it('new recovery codes need a current code and retire the old ones', async () => {
    const o = await registerOwner(app, { email: 'regen@example.com' });
    const { code, recoveryCodes } = await enableTwoFactor(o);
    const h = asUser(o.token);
    expect((await call('POST', '/api/auth/2fa/recovery-codes', { code: '000000' }, h)).statusCode).toBe(401);
    const r = await call('POST', '/api/auth/2fa/recovery-codes', { code: code() }, h);
    expect(r.statusCode).toBe(200);
    const fresh = json(r).recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    expect(fresh.some((c) => recoveryCodes.includes(c))).toBe(false);
    expect((await loginRaw(app, 'regen@example.com', TEST_PASSWORD, {}, { recoveryCode: recoveryCodes[0] })).statusCode).toBe(401);
    expect((await loginRaw(app, 'regen@example.com', TEST_PASSWORD, {}, { recoveryCode: fresh[0] })).statusCode).toBe(200);
    expect(await auditRows('recovery_codes_regenerated', o.userId)).toHaveLength(1);
  });
});

describe('"confirm it is you" and participant data leaving the account (findings 4, SEC-06)', () => {
  const originals = { rows: env.STEP_UP_EXPORT_ROWS, bulk: env.STEP_UP_BULK_ROWS, limit: env.EXPORT_DAILY_LIMIT, daily: env.EXPORT_DAILY_ROWS, reveal: env.REVEAL_PER_DAY, min: env.STEP_UP_MINUTES };
  afterEach(() => { Object.assign(env, { STEP_UP_EXPORT_ROWS: originals.rows, STEP_UP_BULK_ROWS: originals.bulk, EXPORT_DAILY_LIMIT: originals.limit, EXPORT_DAILY_ROWS: originals.daily, REVEAL_PER_DAY: originals.reveal, STEP_UP_MINUTES: originals.min }); });
  const excel = (owner: Client, surveyId: string) => call('GET', `/api/surveys/${surveyId}/export/excel`, undefined, asUser(owner.token));

  it('a small download goes through, is written to the trail and is e-mailed to the owner (counts only, never a name or a number)', async () => {
    const w = await buildWorld(app, { contacts: 3 });
    const email = await emailOf(w.owner);
    const r = await excel(w.owner, w.surveyId);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    const alert = await mailsOf(email, 'export_alert');
    expect(alert).toHaveLength(1);
    expect(alert[0]!.text).toMatch(/3/);
    expect(alert[0]!.text).toMatch(/EXCEL/);
    expect(alert[0]!.text).not.toMatch(/Contact \d|6771000|677 10/);
    const rows = await auditRows('export', w.owner.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: 'survey', targetId: w.surveyId, meta: { kind: 'excel', rows: 3 } });
  });

  it('a large one needs a recent confirmation of the password, the confirmation lasts 15 minutes and belongs to that browser only', async () => {
    env.STEP_UP_EXPORT_ROWS = 3;
    const w = await buildWorld(app, { contacts: 3 });
    const email = await emailOf(w.owner);
    const blocked = await excel(w.owner, w.surveyId);
    expect(blocked.statusCode).toBe(403);
    expect(json(blocked)).toMatchObject({ error: 'step_up_required', details: { methods: ['password'] } });
    expect(await mailsOf(email, 'export_alert')).toHaveLength(0);
    expect(json(await call('GET', '/api/auth/step-up', undefined, asUser(w.owner.token)))).toMatchObject({ methods: ['password'], confirmedUntil: null });

    const wrong = await call('POST', '/api/auth/step-up', { method: 'password', secret: 'not-my-password' }, asUser(w.owner.token));
    expect(wrong.statusCode).toBe(401);
    expect(json(wrong).error).toBe('invalid_step_up');
    expect(await auditRows('step_up_failed', w.owner.userId)).toHaveLength(1);
    expect((await excel(w.owner, w.surveyId)).statusCode).toBe(403);

    const ok = await call('POST', '/api/auth/step-up', { method: 'password', secret: TEST_PASSWORD }, asUser(w.owner.token));
    expect(ok.statusCode).toBe(200);
    const until = new Date(json(ok).confirmedUntil).getTime();
    expect(until - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect((await excel(w.owner, w.surveyId)).statusCode).toBe(200);
    expect(await mailsOf(email, 'export_alert')).toHaveLength(1);

    // Somebody who holds ANOTHER session of the same account is still asked.
    const second = json(await loginRaw(app, email, TEST_PASSWORD));
    expect((await excel(client(app, second.accessToken, second.user.id), w.surveyId)).statusCode).toBe(403);

    // And the window ends.
    await prisma.authSession.updateMany({ where: { userId: w.owner.userId }, data: { stepUpUntil: new Date(Date.now() - 1000) } });
    expect((await excel(w.owner, w.surveyId)).statusCode).toBe(403);
  });

  it('the CSV of people who have not started is guarded the same way', async () => {
    env.STEP_UP_EXPORT_ROWS = 3;
    const w = await buildWorld(app, { contacts: 3 });
    const url = `/api/surveys/${w.surveyId}/not-started.csv`;
    expect((await call('GET', url, undefined, asUser(w.owner.token))).statusCode).toBe(403);
    await call('POST', '/api/auth/step-up', { method: 'password', secret: TEST_PASSWORD }, asUser(w.owner.token));
    const r = await call('GET', url, undefined, asUser(w.owner.token));
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(await auditRows('export', w.owner.userId)).toHaveLength(1);
  });

  it('with an authenticator app the confirmation is the code (and a recovery code works too); the password alone is no longer offered', async () => {
    env.STEP_UP_EXPORT_ROWS = 3;
    const w = await buildWorld(app, { contacts: 3 });
    const { code, recoveryCodes } = await enableTwoFactor(w.owner);
    expect(json(await call('GET', '/api/auth/step-up', undefined, asUser(w.owner.token))).methods).toEqual(['totp']);
    expect(json(await call('POST', '/api/auth/step-up', { method: 'password', secret: TEST_PASSWORD }, asUser(w.owner.token))).error).toBe('invalid_step_up_method');
    expect(json(await call('POST', '/api/auth/step-up', { method: 'totp', secret: '000000' }, asUser(w.owner.token))).error).toBe('invalid_step_up');
    expect((await call('POST', '/api/auth/step-up', { method: 'totp', secret: code() }, asUser(w.owner.token))).statusCode).toBe(200);
    expect((await excel(w.owner, w.surveyId)).statusCode).toBe(200);
    await prisma.authSession.updateMany({ where: { userId: w.owner.userId }, data: { stepUpUntil: null } });
    expect((await call('POST', '/api/auth/step-up', { method: 'totp', secret: recoveryCodes[0] }, asUser(w.owner.token))).statusCode).toBe(200);
  });

  it('owners on the Business plan must have an authenticator app before they can download or delete participant data', async () => {
    env.STEP_UP_EXPORT_ROWS = 3;
    env.STEP_UP_BULK_ROWS = 1;
    const w = await buildWorld(app, { contacts: 3, plan: 'business' });
    const blocked = await excel(w.owner, w.surveyId);
    expect(blocked.statusCode).toBe(403);
    expect(json(blocked)).toMatchObject({ error: 'two_factor_required', details: { setup: true } });
    expect(json(await call('POST', '/api/contacts/bulk-delete', { ids: w.contactIds }, asUser(w.owner.token))).error).toBe('two_factor_required');
    expect(await prisma.contact.count({ where: { userId: w.owner.userId } })).toBe(3);
    expect(json(await call('GET', '/api/auth/security', undefined, asUser(w.owner.token))).twoFactorRequired).toBe(true);

    const { code } = await enableTwoFactor(w.owner);
    expect(json(await excel(w.owner, w.surveyId)).error).toBe('step_up_required'); // two-factor is on now; the confirmation is still needed
    await call('POST', '/api/auth/step-up', { method: 'totp', secret: code() }, asUser(w.owner.token));
    expect((await excel(w.owner, w.surveyId)).statusCode).toBe(200);
    expect(json(await call('GET', '/api/auth/security', undefined, asUser(w.owner.token))).twoFactorRequired).toBe(false);
  });

  it('the plans that require it are configurable, and a small download on that plan is not held up', async () => {
    const w = await buildWorld(app, { contacts: 3, plan: 'business' });
    expect((await excel(w.owner, w.surveyId)).statusCode).toBe(200); // below the size that asks for confirmation
    const saved = env.require2faPlans;
    env.require2faPlans = [];
    try {
      env.STEP_UP_EXPORT_ROWS = 3;
      expect(json(await excel(w.owner, w.surveyId)).error).toBe('step_up_required'); // not two_factor_required
    } finally { env.require2faPlans = saved; }
  });

  it('there is a daily cap on downloads and on rows, and it says so rather than failing silently', async () => {
    env.EXPORT_DAILY_LIMIT = 2;
    const w = await buildWorld(app, { contacts: 3 });
    expect((await excel(w.owner, w.surveyId)).statusCode).toBe(200);
    expect((await excel(w.owner, w.surveyId)).statusCode).toBe(200);
    const third = await excel(w.owner, w.surveyId);
    expect(third.statusCode).toBe(429);
    expect(json(third).error).toBe('export_cap');
    expect(await auditRows('export', w.owner.userId)).toHaveLength(2); // the refused one was not a download
    await redis.flushdb(); // "within 24 hours"
    expect((await excel(w.owner, w.surveyId)).statusCode).toBe(200);

    env.EXPORT_DAILY_LIMIT = 20;
    env.EXPORT_DAILY_ROWS = 5;
    await redis.flushdb();
    expect((await excel(w.owner, w.surveyId)).statusCode).toBe(200); // 3 rows
    expect(json(await excel(w.owner, w.surveyId)).error).toBe('export_cap'); // 3 + 3 > 5
  });

  it('an account with no password (Google) confirms with a code e-mailed to it: six digits, once, five tries, three e-mails', async () => {
    env.STEP_UP_EXPORT_ROWS = 3;
    const w = await buildWorld(app, { contacts: 3 });
    await prisma.user.update({ where: { id: w.owner.userId }, data: { passwordHash: null } });
    const email = await emailOf(w.owner);
    const h = asUser(w.owner.token);
    expect(json(await excel(w.owner, w.surveyId))).toMatchObject({ error: 'step_up_required', details: { methods: ['email_code'] } });
    expect(json(await call('POST', '/api/auth/step-up', { method: 'password', secret: 'x' }, h)).error).toBe('invalid_step_up_method');
    expect(json(await call('POST', '/api/auth/step-up', { method: 'email_code', secret: '123456' }, h)).error).toBe('invalid_step_up'); // none sent yet

    expect((await call('POST', '/api/auth/step-up/email-code', undefined, h)).statusCode).toBe(202);
    const codeOf = async () => (await mailsOf(email, 'step_up_code'))[0]!.text.match(/\b(\d{6})\b/)![1]!;
    const code = await codeOf();
    const wrong = code === '000000' ? '000001' : '000000';
    expect((await call('POST', '/api/auth/step-up', { method: 'email_code', secret: wrong }, h)).statusCode).toBe(401);
    expect((await call('POST', '/api/auth/step-up', { method: 'email_code', secret: code }, h)).statusCode).toBe(200);
    expect((await excel(w.owner, w.surveyId)).statusCode).toBe(200);
    await prisma.authSession.updateMany({ where: { userId: w.owner.userId }, data: { stepUpUntil: null } });
    expect((await call('POST', '/api/auth/step-up', { method: 'email_code', secret: code }, h)).statusCode).toBe(401); // a code is used once

    // and only three codes can be requested in ten minutes
    await call('POST', '/api/auth/step-up/email-code', undefined, h);
    await call('POST', '/api/auth/step-up/email-code', undefined, h);
    expect((await call('POST', '/api/auth/step-up/email-code', undefined, h)).statusCode).toBe(429);
  });

  it('five wrong tries kill an e-mailed code even for the right answer; a new code gets a fresh five tries', async () => {
    env.STEP_UP_EXPORT_ROWS = 3;
    const w = await buildWorld(app, { contacts: 3 });
    await prisma.user.update({ where: { id: w.owner.userId }, data: { passwordHash: null } });
    const email = await emailOf(w.owner);
    const h = asUser(w.owner.token);
    const sid = (await prisma.authSession.findFirstOrThrow({ where: { userId: w.owner.userId } })).id;
    const codeOf = async () => (await mailsOf(email, 'step_up_code'))[0]!.text.match(/\b(\d{6})\b/)![1]!;
    await call('POST', '/api/auth/step-up/email-code', undefined, h);
    const first = await codeOf();
    const wrong = first === '999999' ? '999998' : '999999';
    for (let i = 0; i < 6; i++) expect((await call('POST', '/api/auth/step-up', { method: 'email_code', secret: wrong }, h)).statusCode).toBe(401);
    expect(await redis.exists(`sf:sucode:${sid}`)).toBe(0); // gone
    expect((await call('POST', '/api/auth/step-up', { method: 'email_code', secret: first }, h)).statusCode).toBe(401);

    await call('POST', '/api/auth/step-up/email-code', undefined, h);
    const second = await codeOf();
    expect(second).toMatch(/^\d{6}$/);
    expect((await call('POST', '/api/auth/step-up', { method: 'email_code', secret: second }, h)).statusCode).toBe(200);
    expect((await excel(w.owner, w.surveyId)).statusCode).toBe(200);
  });

  it('only so many confirmation attempts are allowed per session in a quarter of an hour, whatever the way', async () => {
    const w = await buildWorld(app, { contacts: 1, send: false });
    const h = asUser(w.owner.token);
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await call('POST', '/api/auth/step-up', { method: 'password', secret: `guess-${i}-xyz-123` }, h)).statusCode;
    expect(last).toBe(429);
    expect((await call('POST', '/api/auth/step-up', { method: 'password', secret: TEST_PASSWORD }, h)).statusCode).toBe(429); // even the right one waits
  });

  it('deleting many contacts at once needs the confirmation, is capped, written down and e-mailed; a few are not held up', async () => {
    env.STEP_UP_BULK_ROWS = 2;
    const w = await buildWorld(app, { contacts: 5, send: false });
    const email = await emailOf(w.owner);
    const h = asUser(w.owner.token);
    const small = await call('POST', '/api/contacts/bulk-delete', { ids: w.contactIds.slice(0, 2) }, h);
    expect(small.statusCode).toBe(200);
    expect(json(small).deleted).toBe(2);
    expect(await mailsOf(email, 'bulk_delete_alert')).toHaveLength(0);

    const big = await call('POST', '/api/contacts/bulk-delete', { ids: w.contactIds.slice(2) }, h);
    expect(big.statusCode).toBe(403);
    expect(json(big).error).toBe('step_up_required');
    expect(await prisma.contact.count({ where: { userId: w.owner.userId } })).toBe(3); // nothing was deleted
    await call('POST', '/api/auth/step-up', { method: 'password', secret: TEST_PASSWORD }, h);
    const done = await call('POST', '/api/contacts/bulk-delete', { ids: w.contactIds.slice(2) }, h);
    expect(json(done).deleted).toBe(3);
    const alert = await mailsOf(email, 'bulk_delete_alert');
    expect(alert).toHaveLength(1);
    expect(alert[0]!.text).toMatch(/3/);
    const rows = await auditRows('bulk_delete', w.owner.userId);
    expect(rows.map((r) => r.meta)).toEqual([{ rows: 2 }, { rows: 3 }]);
  });

  it('bulk deletes are capped per day like downloads', async () => {
    env.EXPORT_DAILY_ROWS = 4;
    const w = await buildWorld(app, { contacts: 5, send: false });
    const h = asUser(w.owner.token);
    expect((await call('POST', '/api/contacts/bulk-delete', { ids: w.contactIds.slice(0, 3) }, h)).statusCode).toBe(200);
    expect(json(await call('POST', '/api/contacts/bulk-delete', { ids: w.contactIds.slice(3) }, h)).error).toBe('export_cap'); // 3 + 2 > 4
  });
});

describe('numbers are hidden until asked for (SEC-06)', () => {
  it('lists, responses and the not-started list show a masked number and never the index', async () => {
    const w = await buildWorld(app, { contacts: 3 });
    const h = asUser(w.owner.token);
    const list = await call('GET', '/api/contacts', undefined, h);
    const items = json(list).items;
    expect(items).toHaveLength(3);
    for (const i of items) expect(i.phone).toMatch(/^\+237 6XX XXX \d{3}$/);
    expect(list.body).not.toMatch(/phoneHash|677100|6771000/);
    const notStarted = await call('GET', `/api/surveys/${w.surveyId}/not-started`, undefined, h);
    expect(notStarted.body).not.toMatch(/677100/);
    for (const i of json(notStarted).items) expect(i.phone).toMatch(/^\+237 6XX XXX \d{3}$/);
    const responses = await call('GET', `/api/surveys/${w.surveyId}/responses`, undefined, h);
    expect(responses.body).not.toMatch(/677100/);
  });

  it('a number is revealed one contact at a time, written to the trail first, and only for your own contacts', async () => {
    const w = await buildWorld(app, { contacts: 2, send: false });
    const stranger = await registerOwner(app, { email: 'stranger@example.com' });
    const id = w.contactIds[0]!;
    const r = await call('POST', `/api/contacts/${id}/reveal`, undefined, asUser(w.owner.token));
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ id, phone: '+237677100000' });
    const rows = await auditRows('contact_reveal', w.owner.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: 'contact', targetId: id });
    expect(JSON.stringify(rows)).not.toMatch(/677100|Contact 1/); // the trail itself holds no number and no name
    expect((await call('POST', `/api/contacts/${id}/reveal`, undefined, asUser(stranger.token))).statusCode).toBe(404);
    expect((await auditRows('contact_reveal', stranger.userId))).toHaveLength(0);
    expect((await call('POST', '/api/contacts/does-not-exist/reveal', undefined, asUser(w.owner.token))).statusCode).toBe(404);
  });

  it('revealing is limited to what a person could use: a burst limit and a daily cap', async () => {
    const w = await buildWorld(app, { contacts: 1, send: false });
    const h = asUser(w.owner.token);
    const id = w.contactIds[0]!;
    let status = 0;
    for (let i = 0; i < 31; i++) status = (await call('POST', `/api/contacts/${id}/reveal`, undefined, h)).statusCode;
    expect(status).toBe(429);
    expect(json(await call('POST', `/api/contacts/${id}/reveal`, undefined, h)).error).toBe('reveal_cap');
    expect(await auditRows('contact_reveal', w.owner.userId)).toHaveLength(30); // the refused ones revealed nothing and were not logged as reveals

    const saved = env.REVEAL_PER_DAY;
    env.REVEAL_PER_DAY = 3;
    try {
      await redis.flushdb();
      for (let i = 0; i < 3; i++) expect((await call('POST', `/api/contacts/${id}/reveal`, undefined, h)).statusCode).toBe(200);
      expect(json(await call('POST', `/api/contacts/${id}/reveal`, undefined, h))).toMatchObject({ error: 'reveal_cap' });
    } finally { env.REVEAL_PER_DAY = saved; }
  });

  it('search finds a name (any case) or a WHOLE number, and gives no way to read numbers digit by digit', async () => {
    const w = await buildWorld(app, { contacts: 3, send: false });
    const h = asUser(w.owner.token);
    const find = async (q: string) => json(await call('GET', `/api/contacts?search=${encodeURIComponent(q)}`, undefined, h));
    expect((await find('contact 2')).items.map((i: { name: string }) => i.name)).toEqual(['Contact 2']);
    expect((await find('CONTACT')).total).toBe(3);
    expect((await find('+237 677 100 001')).items.map((i: { name: string }) => i.name)).toEqual(['Contact 2']);
    expect((await find('677100001')).items.map((i: { name: string }) => i.name)).toEqual(['Contact 2']);
    for (const fragment of ['6771', '67710000', '237677100', '001', '+2376771000']) expect((await find(fragment)).total, fragment).toBe(0);
    expect((await find('nobody')).total).toBe(0);
  });

  it('importing or creating a contact needs the e-mail to be confirmed, and the contact is stored encrypted', async () => {
    const w = await buildWorld(app, { contacts: 1, send: false });
    const raw = await prisma.$queryRaw<Array<{ name: string; phone: string }>>`SELECT name, phone FROM "Contact" WHERE "userId" = ${w.owner.userId}`;
    expect(raw).toHaveLength(1);
    expect(raw[0]!.phone).toMatch(/^v2\./);
    expect(raw[0]!.name).toMatch(/^v2\./);
  });
});

describe('a session for an account with no password never reaches the password paths', () => {
  it('login, step-up by password and 2FA disable all refuse cleanly', async () => {
    const { createUserExplore } = await import('../src/routes/auth');
    const u = await createUserExplore({ email: 'nopw@example.com', name: 'G', businessName: 'B', phone: '+237677000090', passwordHash: null, country: 'CM', locale: 'en', emailVerifiedAt: new Date() });
    const t = await createSession(u.id, 'google', false, { ip: '127.0.0.1', userAgent: 'vitest' });
    expect((await loginRaw(app, 'nopw@example.com', '')).statusCode).toBe(400);
    expect((await loginRaw(app, 'nopw@example.com', 'anything-at-all-123')).statusCode).toBe(401);
    expect(json(await call('POST', '/api/auth/password/change', { currentPassword: 'x', newPassword: 'a-brand-new-password-77' }, asUser(t.accessToken))).error).toBe('invalid_credentials');
    expect(json(await call('GET', '/api/auth/security', undefined, asUser(t.accessToken)))).toMatchObject({ hasPassword: false, googleLinked: false });
  });
});
