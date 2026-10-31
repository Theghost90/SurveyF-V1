import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { env } from '../src/config/env';
import { clientIp, ipPrefix } from '../src/lib/client-ip';
import { encryptSecret } from '../src/lib/crypto';
import { Prisma, prisma, rawPrisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { runRetention } from '../src/jobs/retention';
import { guardAuditLog, prepareDatabase } from '../src/services/startup';
import { createEmailToken } from '../src/services/security/email-tokens';
import { TEST_PASSWORD, buildWorld, loginRaw, makeApp, registerOwner, resetAll } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
beforeEach(async () => { await resetAll(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });

const call = (method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'content-type': 'application/json', ...headers }, payload: body === undefined ? undefined : JSON.stringify(body) });
const asUser = (token: string) => ({ authorization: `Bearer ${token}` });
const silent = { info: () => undefined, warn: () => undefined };
const DAY = 86_400_000;

describe('the audit trail only grows (SEC-08)', () => {
  it('refuses to change or delete a row, by any route, and says why', async () => {
    const row = await prisma.auditLog.create({ data: { action: 'probe' } });
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET action = 'tampered' WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.updateMany({ data: { userId: 'someone' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
    expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } })).action).toBe('probe');
  });

  it('only the retention job can delete, inside its own transaction, and only what is old', async () => {
    await prisma.$executeRaw`INSERT INTO "AuditLog" (id, at, action) VALUES ('old-1', now() - interval '500 days', 'login'), ('old-2', now() - interval '401 days', 'login'), ('recent', now() - interval '399 days', 'login'), ('fresh', now(), 'login')`;
    const r = await runRetention();
    expect(r.auditRows).toBe(2);
    expect((await prisma.auditLog.findMany({ orderBy: { id: 'asc' } })).map((a) => a.id)).toEqual(['fresh', 'recent']);
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/); // the permission ended with that transaction
  });

  it('is put back by the start-up check, however many times it runs (a database made with `db push` has no migration SQL)', async () => {
    await guardAuditLog();
    await guardAuditLog();
    const row = await prisma.auditLog.create({ data: { action: 'probe' } });
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { action: 'x' } })).rejects.toThrow(/append-only/);
    const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`SELECT tgname FROM pg_trigger WHERE tgrelid = '"AuditLog"'::regclass AND NOT tgisinternal`;
    expect(triggers.map((t) => t.tgname)).toEqual(['sf_audit_log_guard']);
  });

  it('holds ids, counts and a coarse place, never a number, a name or an address', async () => {
    const w = await buildWorld(app, { contacts: 2, send: false });
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: w.owner.userId } })).email;
    await loginRaw(app, email, TEST_PASSWORD, { 'x-sf-client-ip': '41.202.207.55', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36' });
    await loginRaw(app, email, 'wrong-password-123', { 'x-sf-client-ip': '41.202.207.55' });
    await call('POST', `/api/contacts/${w.contactIds[0]}/reveal`, undefined, asUser(w.owner.token));
    await call('GET', `/api/surveys/${w.surveyId}/export/excel`, undefined, asUser(w.owner.token));
    await call('POST', '/api/contacts/bulk-delete', { ids: w.contactIds }, asUser(w.owner.token));
    const rows = await prisma.auditLog.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const all = JSON.stringify(rows);
    expect(all).not.toMatch(/677100|Contact 1|Contact 2|@|41\.202\.207\.55|Mozilla|\$argon2|rt_/);
    expect(rows.find((r) => r.action === 'login')).toMatchObject({ ipPrefix: '41.202.207.x', userAgent: 'Chrome · Windows' });
  });

  it('an action that must not happen unrecorded does not happen when the record cannot be written; sign-in, which must keep working, does not wait on it', async () => {
    const w = await buildWorld(app, { contacts: 2, send: false });
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: w.owner.userId } })).email;
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION sf_test_refuse() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit store unavailable'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER sf_test_refuse BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION sf_test_refuse()`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const reveal = await call('POST', `/api/contacts/${w.contactIds[0]}/reveal`, undefined, asUser(w.owner.token));
      expect(reveal.statusCode).toBe(500);
      expect(reveal.body).not.toMatch(/677100/);
      const xl = await call('GET', `/api/surveys/${w.surveyId}/export/excel`, undefined, asUser(w.owner.token));
      expect(xl.statusCode).toBe(500);
      expect(xl.headers['content-type']).not.toContain('spreadsheetml');
      expect((await call('POST', '/api/contacts/bulk-delete', { ids: w.contactIds }, asUser(w.owner.token))).statusCode).toBe(500);
      expect(await prisma.contact.count({ where: { userId: w.owner.userId } })).toBe(2);
      expect((await loginRaw(app, email, TEST_PASSWORD)).statusCode).toBe(200);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS sf_test_refuse ON "AuditLog"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS sf_test_refuse()`);
    }
    expect((await call('POST', `/api/contacts/${w.contactIds[0]}/reveal`, undefined, asUser(w.owner.token))).statusCode).toBe(200);
  });
});

describe('housekeeping (retention)', () => {
  const ago = (ms: number) => new Date(Date.now() - ms);
  const makeUser = async (email: string, over: { verified: boolean; ageHours: number }) => {
    const u = await rawPrisma.user.create({ data: { email, emailCanonical: email, name: 'N', businessName: 'B', phone: '+237677000050', country: 'CM', emailVerifiedAt: over.verified ? new Date() : null } });
    await prisma.$executeRaw`UPDATE "User" SET "createdAt" = ${ago(over.ageHours * 3_600_000)} WHERE id = ${u.id}`;
    return u;
  };

  it('deletes accounts never confirmed after 24 hours, and nothing else that matters', async () => {
    const stale = await makeUser('stale@example.com', { verified: false, ageHours: 25 });
    const young = await makeUser('young@example.com', { verified: false, ageHours: 23 });
    const confirmed = await makeUser('confirmed@example.com', { verified: true, ageHours: 500 });
    const withNumber = await makeUser('withnumber@example.com', { verified: false, ageHours: 30 });
    await prisma.whatsAppAccount.create({ data: { userId: withNumber.id, wabaId: 'w1', phoneNumberId: 'p1', displayPhone: '+237600000000', accessToken: encryptSecret('t'), status: 'active' } });
    const withMoney = await makeUser('withmoney@example.com', { verified: false, ageHours: 30 });
    await prisma.walletEntry.create({ data: { userId: withMoney.id, delta: 1000, balanceAfter: 1000, kind: 'topup' } });
    const r = await runRetention();
    expect(r.unverifiedAccounts).toBe(1);
    const left = (await prisma.user.findMany({ select: { email: true } })).map((u) => u.email).sort();
    expect(left).toEqual(['confirmed@example.com', 'withmoney@example.com', 'withnumber@example.com', 'young@example.com']);
    expect(stale.id).not.toBe(young.id);
    expect(confirmed.id).toBeTruthy();
  });

  it('clears old links and ended sessions but keeps what is still live', async () => {
    const u = await makeUser('keep@example.com', { verified: true, ageHours: 5 });
    const live = await createEmailToken(u.id, 'reset_password');
    const used = await createEmailToken(u.id, 'verify_email');
    await prisma.emailToken.updateMany({ where: { purpose: 'verify_email' }, data: { usedAt: ago(8 * DAY) } });
    await createEmailToken(u.id, 'link_google');
    await prisma.emailToken.updateMany({ where: { purpose: 'link_google' }, data: { expiresAt: ago(8 * DAY) } });
    const mk = (over: Record<string, unknown>) => prisma.authSession.create({ data: { userId: u.id, refreshHash: 'h', method: 'password', deviceKey: 'd', expiresAt: new Date(Date.now() + DAY), ...over } as never });
    const active = await mk({});
    await mk({ revokedAt: ago(31 * DAY) });
    await mk({ revokedAt: ago(1 * DAY) });
    await mk({ expiresAt: ago(31 * DAY) });
    const r = await runRetention();
    expect(r).toMatchObject({ emailTokens: 2, sessions: 2 });
    expect(await prisma.emailToken.count()).toBe(1);
    expect(await prisma.authSession.count()).toBe(2);
    expect((await prisma.authSession.findUnique({ where: { id: active.id } }))?.id).toBe(active.id);
    expect(live).not.toBe(used);
  });
});

describe('a reply parked for retry does not become a readable copy of the number (SEC-15)', () => {
  it('stores the participant\'s number encrypted, sends to the real number, and drops the payload when the job is over', async () => {
    const { enqueueSessionMessage, runSendWorkerOnce } = await import('../src/services/whatsapp/sender');
    const owner = await registerOwner(app);
    const acct = await prisma.whatsAppAccount.findFirstOrThrow({ where: { userId: owner.userId } });
    await enqueueSessionMessage(owner.userId, acct.phoneNumberId, '237677000999', [{ kind: 'text', body: 'Thank you for answering' }]);
    const [raw] = await prisma.$queryRaw<Array<{ payload: { to: string } }>>`SELECT payload FROM "SendJob" WHERE kind = 'session_message'`;
    expect(raw!.payload.to).toMatch(/^v2\./);
    expect(JSON.stringify(raw)).not.toContain('237677000999');
    await runSendWorkerOnce(10);
    expect(await redis.keys('sf:mock:chat:*:237677000999')).toHaveLength(1); // it reached the real number
    const [after] = await prisma.$queryRaw<Array<{ status: string; payload: unknown }>>`SELECT status, payload FROM "SendJob" WHERE kind = 'session_message'`;
    expect(after).toEqual({ status: 'done', payload: null });
  });

  it('a job parked before this existed (plain number) still goes out, and the retention job empties the payload of a job that failed for good', async () => {
    const { runSendWorkerOnce } = await import('../src/services/whatsapp/sender');
    const owner = await registerOwner(app);
    const acct = await prisma.whatsAppAccount.findFirstOrThrow({ where: { userId: owner.userId } });
    await prisma.sendJob.create({ data: { userId: owner.userId, kind: 'session_message', payload: { phoneNumberId: acct.phoneNumberId, to: '237677000998', messages: [{ kind: 'text', body: 'older job' }] } } });
    await runSendWorkerOnce(10);
    expect(await redis.keys('sf:mock:chat:*:237677000998')).toHaveLength(1);
    await prisma.sendJob.create({ data: { userId: owner.userId, kind: 'session_message', status: 'failed', lastError: 'account_missing', payload: { phoneNumberId: 'gone', to: '237677000997', messages: [] } } });
    const r = await runRetention();
    expect(r.parkedPayloads).toBeGreaterThanOrEqual(1);
    expect(await prisma.sendJob.count({ where: { kind: 'session_message', NOT: { payload: { equals: Prisma.DbNull } } } })).toBe(0);
  });
});

describe('what runs at start-up', () => {
  it('accounts that predate e-mail confirmation are treated as confirmed ONCE; later ones must confirm', async () => {
    await prisma.backfill.deleteMany();
    const old = await rawPrisma.user.create({ data: { email: 'legacy@example.com', name: 'L', businessName: 'B', phone: '+237677000060', country: 'CM' } });
    expect(old.emailVerifiedAt).toBeNull();
    await prepareDatabase(silent);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: old.id } })).emailVerifiedAt).not.toBeNull();
    const later = await rawPrisma.user.create({ data: { email: 'later@example.com', name: 'L', businessName: 'B', phone: '+237677000061', country: 'CM' } });
    await prepareDatabase(silent);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: later.id } })).emailVerifiedAt).toBeNull(); // the marker is set: the fix never runs again
  });

  it('fills the canonical address of old accounts, and when two old accounts are one mailbox both keep working', async () => {
    const a = await rawPrisma.user.create({ data: { email: 'Old.User+a@gmail.com', name: 'A', businessName: 'B', phone: '+237677000062', country: 'CM' } });
    const b = await rawPrisma.user.create({ data: { email: 'olduser+b@gmail.com', name: 'B', businessName: 'B', phone: '+237677000063', country: 'CM' } });
    const c = await rawPrisma.user.create({ data: { email: 'Plain@Example.com', name: 'C', businessName: 'B', phone: '+237677000064', country: 'CM' } });
    await prepareDatabase(silent);
    const canon = async (id: string) => (await rawPrisma.user.findUniqueOrThrow({ where: { id } })).emailCanonical;
    const [ca, cb, cc] = [await canon(a.id), await canon(b.id), await canon(c.id)];
    expect(cc).toBe('plain@example.com');
    expect([ca, cb].sort()).toEqual(['olduser+b@gmail.com', 'olduser@gmail.com'].sort()); // the first gets the folded form, the second keeps its own address
    expect(new Set([ca, cb]).size).toBe(2);
  });

  it('the website\'s sign-in works for both after that', async () => {
    const hash = (await import('../src/lib/password')).hashPassword;
    await rawPrisma.user.create({ data: { email: 'both.one@gmail.com', name: 'A', businessName: 'B', phone: '+237677000065', country: 'CM', passwordHash: await hash(TEST_PASSWORD), emailVerifiedAt: new Date() } });
    await rawPrisma.user.create({ data: { email: 'bothone+x@gmail.com', name: 'B', businessName: 'B', phone: '+237677000066', country: 'CM', passwordHash: await hash(TEST_PASSWORD), emailVerifiedAt: new Date() } });
    await prepareDatabase(silent);
    expect((await loginRaw(app, 'both.one@gmail.com', TEST_PASSWORD)).statusCode).toBe(200);
    expect((await loginRaw(app, 'bothone+x@gmail.com', TEST_PASSWORD)).statusCode).toBe(200);
  });
});

describe('who is really calling (SEC-07)', () => {
  const fake = (headers: Record<string, string>, remote = '10.0.0.5') => ({ headers, socket: { remoteAddress: remote } }) as unknown as FastifyRequest;
  const SECRET = 'a-shared-secret-of-the-website-server-0123456789';

  it('with no website secret configured (local development) the forwarded address is used when it is a real address', () => {
    expect(clientIp(fake({ 'x-sf-client-ip': '41.202.207.55' }))).toBe('41.202.207.55');
    expect(clientIp(fake({ 'x-sf-client-ip': '2001:db8::1' }))).toBe('2001:db8::1');
    expect(clientIp(fake({ 'x-sf-client-ip': 'not an ip' }))).toBe('10.0.0.5');
    expect(clientIp(fake({}, '::ffff:192.0.2.9'))).toBe('192.0.2.9');
    expect(clientIp({ headers: {} } as unknown as FastifyRequest)).toBe('unknown');
  });

  it('with the secret configured it is believed only on a request that carries the secret; X-Forwarded-For is never believed', () => {
    env.INTERNAL_API_SECRET = SECRET;
    try {
      expect(clientIp(fake({ 'x-sf-client-ip': '41.202.207.55', 'x-internal-secret': SECRET }))).toBe('41.202.207.55');
      expect(clientIp(fake({ 'x-sf-client-ip': '41.202.207.55' }))).toBe('10.0.0.5');
      expect(clientIp(fake({ 'x-sf-client-ip': '41.202.207.55', 'x-internal-secret': 'wrong' }))).toBe('10.0.0.5');
      expect(clientIp(fake({ 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '7.7.7.7', 'x-internal-secret': SECRET }))).toBe('10.0.0.5');
      expect(clientIp(fake({ 'x-forwarded-for': '6.6.6.6' }))).toBe('10.0.0.5');
      const req = fake({ 'x-sf-client-ip': '41.202.207.55', 'x-internal-secret': SECRET });
      expect(clientIp(req)).toBe(clientIp(req));
    } finally { env.INTERNAL_API_SECRET = undefined; }
  });

  it('is shown only coarsely', () => {
    expect(ipPrefix('41.202.207.55')).toBe('41.202.207.x');
    expect(ipPrefix('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3::');
    expect(ipPrefix('unknown')).toBeNull();
    expect(ipPrefix(null)).toBeNull();
  });

  it('through the website a sign-in is recorded from the visitor\'s address, and an X-Forwarded-For sent by the visitor changes nothing', async () => {
    env.INTERNAL_API_SECRET = SECRET;
    try {
      const o = await registerOwner(app, { email: 'ip@example.com' });
      const h = { 'x-internal-secret': SECRET };
      const r = await loginRaw(app, 'ip@example.com', TEST_PASSWORD, { ...h, 'x-sf-client-ip': '41.202.207.55', 'x-forwarded-for': '6.6.6.6' });
      expect(r.statusCode).toBe(200);
      expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'login', userId: o.userId } })).ipPrefix).toBe('41.202.207.x');
      // a direct call (no secret) is refused before any handler
      expect((await loginRaw(app, 'ip@example.com', TEST_PASSWORD, { 'x-sf-client-ip': '41.202.207.55' })).statusCode).toBe(403);
    } finally { env.INTERNAL_API_SECRET = undefined; }
  });
});

describe('logs carry no query strings, cookies or credentials (SEC-14)', () => {
  it('records the path of a request, never what follows the "?", and no header', async () => {
    const lines: string[] = [];
    const logged = await buildApp({ logStream: { write: (l) => { lines.push(l); } } });
    await logged.ready();
    try {
      await logged.inject({
        method: 'GET', url: '/api/contacts?search=%2B237677123456&token=abc123secrettoken',
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature', cookie: 'next-auth.session-token=cookie-secret-value', 'x-sf-client-ip': '41.202.207.55', 'x-internal-secret': 'x', 'x-hub-signature-256': 'sha256=deadbeef' },
      });
      await logged.inject({ method: 'GET', url: '/healthz?probe=1' });
    } finally { await logged.close(); }
    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(all).toContain('/api/contacts');
    for (const secret of ['677123456', 'abc123secrettoken', 'eyJhbGci', 'cookie-secret-value', '41.202.207.55', 'deadbeef', 'probe=1']) expect(all, secret).not.toContain(secret);
  });
});

describe('what the API says about itself', () => {
  it('sends the standard hardening headers and nothing that names the software', async () => {
    const r = await call('GET', '/healthz');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBeTruthy();
    expect(r.headers['strict-transport-security']).toBeTruthy();
    expect(r.headers['referrer-policy']).toBeTruthy();
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('keeps the demo mailbox to the mock provider, and it is only a mailbox for the address it is asked about', async () => {
    const r = await call('GET', '/api/dev/mailbox?to=nobody@example.com');
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ items: [] });
    expect((await call('GET', '/api/dev/mailbox?to=not-an-address')).statusCode).toBe(400);
  });
});

/** The production start-up checks run when config/env.ts loads, so each case loads it again under a different environment. */
async function bootInProduction(over: Record<string, string>): Promise<{ ok: boolean; problems: string }> {
  const saved = { ...process.env };
  const base: Record<string, string> = {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://x:y@db.example.com:5432/z', JWT_SECRET: 'p'.repeat(40), ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`, TOKEN_ENCRYPTION_KEY: '',
    BLIND_INDEX_KEY: randomBytes(32).toString('base64'), INTERNAL_API_SECRET: 'i'.repeat(40), WHATSAPP_MODE: 'live', META_APP_SECRET: 'meta-secret', PSP_MOCK: 'false',
    GIFT_PROVIDER: 'campay', CAMPAY_API_KEY: 'campay', NOTCHPAY_API_KEY: 'notch', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_123', EMAIL_FROM: 'SurveyFlow <no-reply@example.com>',
    TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret', CAPTCHA_DISABLED: '', PUBLIC_WEB_URL: 'https://app.example.com', WEB_ORIGIN: 'https://app.example.com', PUBLIC_API_URL: 'https://api.example.com',
  };
  Object.assign(process.env, base, over);
  const errors: string[] = [];
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
  const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.resetModules();
  try { await import('../src/config/env'); return { ok: true, problems: '' }; } catch { return { ok: false, problems: errors.join('\n') }; } finally {
    exit.mockRestore(); err.mockRestore(); vi.mocked(console.warn).mockRestore?.();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe('production refuses to start with a protection missing (SEC-02, SEC-03, SEC-15)', () => {
  it('starts with everything in place', async () => {
    expect(await bootInProduction({})).toEqual({ ok: true, problems: '' });
  });

  it('refuses each of these on its own, and says which', async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ EMAIL_PROVIDER: 'mock', RESEND_API_KEY: '' }, /EMAIL_PROVIDER must be smtp, resend or brevo/],
      [{ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: '' }, /needs RESEND_API_KEY/],
      [{ EMAIL_PROVIDER: 'smtp', SMTP_URL: '' }, /needs SMTP_URL/],
      [{ EMAIL_FROM: 'SurveyFlow <no-reply@surveyflow.local>' }, /EMAIL_FROM must be a real sender/],
      [{ TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '' }, /TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY/],
      [{ BLIND_INDEX_KEY: '' }, /BLIND_INDEX_KEY must be set/],
      [{ ENCRYPTION_KEYS: '', TOKEN_ENCRYPTION_KEY: '' }, /ENCRYPTION_KEYS/],
      [{ PUBLIC_WEB_URL: 'http://app.example.com', WEB_ORIGIN: 'http://app.example.com' }, /PUBLIC_WEB_URL .* https/],
      [{ PUBLIC_WEB_URL: 'https://localhost:4222', WEB_ORIGIN: 'https://localhost:4222' }, /PUBLIC_WEB_URL .* https/],
      [{ INTERNAL_API_SECRET: 'short' }, /INTERNAL_API_SECRET/],
      [{ JWT_SECRET: 'short' }, /JWT_SECRET/],
    ];
    for (const [over, message] of cases) {
      const r = await bootInProduction(over);
      expect(r.ok, JSON.stringify(over)).toBe(false);
      expect(r.problems, JSON.stringify(over)).toMatch(message);
    }
  });

  it('lets an operator run without a CAPTCHA only by saying so', async () => {
    expect((await bootInProduction({ TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '', CAPTCHA_DISABLED: 'true' })).ok).toBe(true);
  });

  it('accepts the older single key in place of the key ring', async () => {
    expect((await bootInProduction({ ENCRYPTION_KEYS: '', TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') })).ok).toBe(true);
  });
});

describe('key rotation (scripts/rotate-keys.mts)', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const run = (args: string[], over: Record<string, string>) =>
    // tsx's own entry run by node: `node_modules/.bin/tsx` is a .cmd shim on Windows, which execFileSync cannot start
    execFileSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'scripts/rotate-keys.mts'), ...args], { env: { ...process.env, ...over }, encoding: 'utf8', timeout: 120_000, cwd: root });
  const devKey = scryptSync('surveyflow-dev-only-encryption-key', 'sf-salt', 32).toString('base64');

  it('reports first, then moves everything onto the new key, and reports nothing left', async () => {
    const owner = await registerOwner(app);
    await prisma.contact.create({ data: { userId: owner.userId, name: 'Rotate Me', phone: '+237677000070' } });
    await prisma.googleConnection.create({ data: { userId: owner.userId, email: 'g@example.com', refreshToken: encryptSecret('google-refresh'), scope: 'sheets' } });
    const k2 = randomBytes(32).toString('base64');
    const ring = { ENCRYPTION_KEYS: `k2:${k2},k1:${devKey}` };
    const wa = await prisma.whatsAppAccount.findFirstOrThrow({ where: { userId: owner.userId } });
    expect((await prisma.$queryRaw<Array<{ accessToken: string }>>`SELECT "accessToken" FROM "WhatsAppAccount" WHERE id = ${wa.id}`)[0]!.accessToken).toMatch(/^v2\.k1\./);

    const dry = run([], ring);
    expect(dry).toMatch(/Active key: k2\s+\(dry run\)/);
    expect(dry).toMatch(/WhatsApp tokens: [1-9]\d* to re-encrypt/);
    expect((await prisma.$queryRaw<Array<{ accessToken: string }>>`SELECT "accessToken" FROM "WhatsAppAccount" WHERE id = ${wa.id}`)[0]!.accessToken).toMatch(/^v2\.k1\./); // a dry run writes nothing

    const applied = run(['--apply'], ring);
    expect(applied).toMatch(/Active key: k2\s+\(APPLY\)/);
    expect(applied).toMatch(/Google tokens: 1 re-encrypted/);
    const stored = await prisma.$queryRaw<Array<{ name: string; phone: string; accessToken: string }>>`SELECT c.name, c.phone, w."accessToken" FROM "Contact" c, "WhatsAppAccount" w WHERE c."userId" = ${owner.userId} AND w.id = ${wa.id}`;
    expect(stored[0]!.name).toMatch(/^v2\.k2\./);
    expect(stored[0]!.phone).toMatch(/^v2\.k2\./);
    expect(stored[0]!.accessToken).toMatch(/^v2\.k2\./);
    const again = run([], ring);
    expect(again).toMatch(/left on an old key: 0/);
    expect((await prisma.$queryRaw<Array<{ refreshToken: string }>>`SELECT "refreshToken" FROM "GoogleConnection" WHERE "userId" = ${owner.userId}`)[0]!.refreshToken).toMatch(/^v2\.k2\./);
    // the application, still on the OLD ring, can no longer read what moved: this is why the old key stays in the ring until the script says 0
    const unreadable = await prisma.contact.findFirstOrThrow({ where: { userId: owner.userId } });
    expect(() => unreadable.name).toThrow(/No encryption key "k2"/);
  }, 180_000);

  it('can rebuild the number index under a new BLIND_INDEX_KEY', async () => {
    const owner = await registerOwner(app);
    const c = await prisma.contact.create({ data: { userId: owner.userId, name: 'Index Me', phone: '+237677000071' } });
    const newKey = randomBytes(32).toString('base64');
    const before = (await rawPrisma.contact.findUniqueOrThrow({ where: { id: c.id } })).phoneHash;
    const out = run(['--apply', '--rehash-index'], { BLIND_INDEX_KEY: newKey, ENCRYPTION_KEYS: `k1:${devKey}` });
    expect(out).toMatch(/number index rebuilt: [1-9]/);
    const after = (await rawPrisma.contact.findUniqueOrThrow({ where: { id: c.id } })).phoneHash;
    expect(after).not.toBe(before);
    expect(after).toBe(createHmac('sha256', Buffer.from(newKey, 'base64')).update('phone:+237677000071').digest('hex'));
  }, 180_000);
});
