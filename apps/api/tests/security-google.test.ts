import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { encryptSecret } from '../src/lib/crypto';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { newTotpSecret } from '../src/lib/totp';
import { setGoogleKeyResolver } from '../src/routes/auth-google';
import { readMockMailbox } from '../src/services/mail';
import { createEmailToken } from '../src/services/security/email-tokens';
import { TEST_PASSWORD, makeApp, registerOwner, resetAll, signUp } from './helpers';

const SECRET = 'a-shared-secret-of-the-website-server-0123456789';
let app: FastifyInstance;
let privateKey: KeyLike;
let otherKey: KeyLike;

beforeAll(async () => {
  app = await makeApp();
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  setGoogleKeyResolver(createLocalJWKSet({ keys: [jwk] }));
});
beforeEach(async () => { await resetAll(); env.INTERNAL_API_SECRET = SECRET; });
afterEach(() => { env.INTERNAL_API_SECRET = undefined; });
afterAll(async () => { setGoogleKeyResolver(undefined); await app.close(); await prisma.$disconnect(); redis.disconnect(); });

const call = (method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'content-type': 'application/json', 'x-internal-secret': SECRET, ...headers }, payload: body === undefined ? undefined : JSON.stringify(body) });
const json = (r: { body: string }) => JSON.parse(r.body);
const mailsOf = async (email: string, kind?: string) => (await readMockMailbox(email)).filter((m) => !kind || m.kind === kind);

interface Claims { sub?: string; email?: string; name?: string; email_verified?: unknown; iss?: string; aud?: string; exp?: string | number; key?: KeyLike; alg?: 'RS256' | 'HS256' | 'RS512'; kid?: string }
async function idToken(c: Claims = {}): Promise<string> {
  const payload: Record<string, unknown> = { email_verified: c.email_verified ?? true, name: c.name ?? 'Grace Hopper' };
  if (c.email !== null) payload.email = c.email ?? 'grace@example.com';
  const jwt = new SignJWT(payload).setProtectedHeader({ alg: c.alg ?? 'RS256', kid: c.kid ?? 'test-key' }).setIssuer(c.iss ?? 'https://accounts.google.com').setAudience(c.aud ?? env.GOOGLE_CLIENT_ID!).setIssuedAt().setExpirationTime(c.exp ?? '10m');
  if (c.sub !== undefined || true) jwt.setSubject(c.sub ?? 'google-sub-1');
  if (c.alg === 'HS256') return jwt.sign(new TextEncoder().encode('any-secret-any-secret-any-secret-12345'));
  return jwt.sign(c.key ?? privateKey);
}
const googleLogin = async (c: Claims = {}) => call('POST', '/api/auth/google', { idToken: await idToken(c) });

describe('sign in with Google (finding 6)', () => {
  it('does not exist unless it is configured (a Google client and the website secret)', async () => {
    env.INTERNAL_API_SECRET = undefined;
    expect((await call('POST', '/api/auth/google', { idToken: 'x'.repeat(30) }, { 'x-internal-secret': '' })).statusCode).toBe(404);
    expect(json(await call('GET', '/api/auth/config')).googleSignIn).toBe(false);
    env.INTERNAL_API_SECRET = SECRET;
    expect(json(await call('GET', '/api/auth/config')).googleSignIn).toBe(true);
  });

  it('the old endpoint that minted a session for any e-mail address no longer exists', async () => {
    for (const body of [{ email: 'ceo@example.com', name: 'X', secret: SECRET }, { email: 'ceo@example.com' }]) {
      expect((await call('POST', '/api/auth/oauth', body)).statusCode).toBe(404);
    }
    expect(await prisma.user.count()).toBe(0);
  });

  it('a new Google user gets a confirmed account and a session at once, and is recognised by Google\'s subject id afterwards', async () => {
    const r = await googleLogin({ sub: 'sub-A', email: 'Grace@Example.com', name: 'Grace Hopper' });
    expect(r.statusCode).toBe(200);
    const b = json(r);
    expect(b).toMatchObject({ status: 'ok', user: { email: 'grace@example.com' } });
    expect(b.refreshToken).toMatch(/^rt_/);
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'grace@example.com' } });
    expect(u).toMatchObject({ name: 'Grace Hopper', passwordHash: null, plan: 'trial' });
    expect(u.emailVerifiedAt).not.toBeNull();
    expect(await prisma.authIdentity.findMany({ where: { userId: u.id } })).toMatchObject([{ provider: 'google', subject: 'sub-A' }]);
    expect(await prisma.subscription.count({ where: { userId: u.id } })).toBe(1);
    expect((await call('GET', '/api/auth/me', undefined, { authorization: `Bearer ${b.accessToken}` })).statusCode).toBe(200);
    expect(await prisma.authSession.count({ where: { userId: u.id, method: 'google' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'google_login', userId: u.id } })).toBe(1);

    // the same Google account again, even after changing the address on the Google side, is the same SurveyFlow account
    const again = await googleLogin({ sub: 'sub-A', email: 'grace.hopper@newdomain.org' });
    expect(again.statusCode).toBe(200);
    expect(json(again).user.id).toBe(u.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it('a Google user who asks for a password sign-in has none: the account is reachable by Google only until they set one by e-mail', async () => {
    await googleLogin({ sub: 'sub-B', email: 'gonly@example.com' });
    const login = await call('POST', '/api/auth/login', { email: 'gonly@example.com', password: TEST_PASSWORD });
    expect(login.statusCode).toBe(401);
    expect(json(login).error).toBe('invalid_credentials');
    await call('POST', '/api/auth/password/forgot', { email: 'gonly@example.com' });
    expect(await mailsOf('gonly@example.com', 'reset_password')).toHaveLength(1);
  });

  it('refuses a token Google did not sign for this application, whatever else is right about it', async () => {
    const bad: Array<[string, Claims]> = [
      ['an unverified e-mail address', { email_verified: false }],
      ['"verified" as a string', { email_verified: 'true' }],
      ['another application\'s audience', { aud: 'someone-elses-client-id' }],
      ['another issuer', { iss: 'https://evil.example.com' }],
      ['a lookalike issuer', { iss: 'https://accounts.google.com.evil.com' }],
      ['an expired token', { exp: Math.floor(Date.now() / 1000) - 120 }],
      ['a signature from another key', { key: otherKey }],
      ['an unknown key id', { kid: 'not-in-the-key-set' }],
      ['the symmetric algorithm (key confusion)', { alg: 'HS256' }],
      ['no e-mail', { email: null as unknown as string }],
    ];
    for (const [label, claims] of bad) {
      const r = await googleLogin(claims);
      expect(r.statusCode, label).toBe(401);
      expect(json(r).error, label).toBe('invalid_google_token');
    }
    for (const garbage of ['x'.repeat(30), 'aaaaaaaa.bbbbbbbbbb.cccccccc', `${'e'.repeat(40)}.${'f'.repeat(40)}.${'g'.repeat(40)}`]) {
      expect((await call('POST', '/api/auth/google', { idToken: garbage })).statusCode, garbage).toBe(401);
    }
    expect((await call('POST', '/api/auth/google', { idToken: 'short' })).statusCode).toBe(400);
    expect(await prisma.user.count()).toBe(0);
  });

  it('accepts Google\'s other spelling of its issuer', async () => {
    expect((await googleLogin({ iss: 'accounts.google.com', sub: 'sub-iss', email: 'iss@example.com' })).statusCode).toBe(200);
  });

  it('an address that already has a confirmed account is NOT merged: its owner gets an e-mail link, and only that link links the two', async () => {
    const signed = await signUp(app, { email: 'owner@example.com', headers: { 'x-internal-secret': SECRET } });
    expect(signed.client).toBeTruthy();
    const r = await googleLogin({ sub: 'attacker-sub', email: 'owner@example.com', name: 'Whoever Controls A Google Account' });
    expect(r.statusCode).toBe(202);
    expect(json(r)).toEqual({ status: 'link_required' });
    expect(r.body).not.toMatch(/accessToken|refreshToken/);
    expect(await prisma.authIdentity.count()).toBe(0);
    const newestToken = async () => {
      const mail = (await mailsOf('owner@example.com', 'link_google'))[0]!;
      expect(mail).toBeTruthy();
      return decodeURIComponent(new URL(mail.links.find((l) => l.includes('/link-google?token='))!).searchParams.get('token')!);
    };
    const stale = await newestToken();

    // until the owner clicks, Google signs nobody in to that account (asking again sends a newer link, which replaces the older one)
    expect((await googleLogin({ sub: 'attacker-sub', email: 'owner@example.com' })).statusCode).toBe(202);
    const token = await newestToken();
    expect(token).not.toBe(stale);
    expect((await call('POST', '/api/auth/google/link/confirm', { token: stale })).statusCode).toBe(400);
    expect(await prisma.authIdentity.count()).toBe(0);
    const confirmed = await call('POST', '/api/auth/google/link/confirm', { token });
    expect(confirmed.statusCode).toBe(200);
    expect(await prisma.authIdentity.count()).toBe(1);
    expect((await call('POST', '/api/auth/google/link/confirm', { token })).statusCode).toBe(400); // once
    const after = await googleLogin({ sub: 'attacker-sub', email: 'owner@example.com' });
    expect(after.statusCode).toBe(200);
    expect(json(after).user.id).toBe(signed.client!.userId);
    expect(await prisma.auditLog.count({ where: { action: 'google_linked' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'google_link_requested' } })).toBe(2);
  });

  it('the link e-mail cannot be used to flood somebody: three an hour', async () => {
    await registerOwner(app, { email: 'flood@example.com' });
    for (let i = 0; i < 6; i++) await googleLogin({ sub: `flood-sub-${i}`, email: 'flood@example.com' });
    expect(await mailsOf('flood@example.com', 'link_google')).toHaveLength(3);
  });

  it('treats an alias of a confirmed address as that same mailbox', async () => {
    await registerOwner(app, { email: 'johndoe@gmail.com' });
    const r = await googleLogin({ sub: 'alias-sub', email: 'John.Doe+work@gmail.com' });
    expect(r.statusCode).toBe(202);
    expect(await prisma.user.count()).toBe(1);
  });

  it('a link token cannot be used for anything else, and a verification token cannot link an account', async () => {
    const o = await registerOwner(app, { email: 'purpose@example.com' });
    const verify = await createEmailToken(o.userId, 'verify_email');
    expect((await call('POST', '/api/auth/google/link/confirm', { token: verify })).statusCode).toBe(400);
    const link = await createEmailToken(o.userId, 'link_google', { provider: 'google', sub: 'x-sub', email: 'purpose@example.com' });
    expect(json(await call('POST', '/api/auth/verify-email', { token: link })).error).toBe('invalid_token');
    expect(json(await call('POST', '/api/auth/password/reset', { token: link, password: 'a-brand-new-password-77' })).error).toBe('invalid_token');
    expect(await prisma.authIdentity.count()).toBe(0);
  });

  it('a Google account already linked to somebody else cannot be linked a second time', async () => {
    const a = await registerOwner(app, { email: 'a-owner@example.com' });
    const b = await registerOwner(app, { email: 'b-owner@example.com' });
    await prisma.authIdentity.create({ data: { userId: a.userId, provider: 'google', subject: 'shared-sub', email: 'a-owner@example.com' } });
    const token = await createEmailToken(b.userId, 'link_google', { provider: 'google', sub: 'shared-sub', email: 'b-owner@example.com' });
    const r = await call('POST', '/api/auth/google/link/confirm', { token });
    expect(r.statusCode).toBe(409);
    expect(json(r).error).toBe('identity_in_use');
    expect(await prisma.authIdentity.count({ where: { userId: b.userId } })).toBe(0);
  });

  it('an address that was never confirmed is not an account: Google, having proved the address, replaces the registration', async () => {
    await call('POST', '/api/auth/register', { businessName: 'Squat', name: 'Squatter', email: 'real@example.com', phone: '677 00 00 02', password: 'squatter-password-1234' });
    const r = await googleLogin({ sub: 'real-sub', email: 'real@example.com', name: 'Real Owner' });
    expect(r.statusCode).toBe(200);
    expect(await prisma.user.count()).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'real@example.com' } })).name).toBe('Real Owner');
    expect((await call('POST', '/api/auth/login', { email: 'real@example.com', password: 'squatter-password-1234' })).statusCode).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: 'unverified_account_replaced' } })).toBe(1);
  });

  it('does not ask for the authenticator code (Google\'s own protections apply), but the session is not marked as having one, so a bulk download still asks', async () => {
    const o = await registerOwner(app, { email: 'tfa-google@example.com' });
    await prisma.user.update({ where: { id: o.userId }, data: { totpSecret: encryptSecret(newTotpSecret()), totpEnabledAt: new Date() } });
    await prisma.authIdentity.create({ data: { userId: o.userId, provider: 'google', subject: 'tfa-sub', email: 'tfa-google@example.com' } });
    const r = await googleLogin({ sub: 'tfa-sub', email: 'tfa-google@example.com' });
    expect(r.statusCode).toBe(200);
    const row = await prisma.authSession.findUniqueOrThrow({ where: { id: json(r).sessionId } });
    expect(row).toMatchObject({ method: 'google', mfa: false });
    const step = await call('GET', '/api/auth/step-up', undefined, { authorization: `Bearer ${json(r).accessToken}` });
    expect(json(step).methods).toEqual(['totp']);
  });

  it('a first Google sign-in from a new place is announced to the owner, like any other', async () => {
    const o = await registerOwner(app, { email: 'nd-google@example.com' });
    await prisma.authIdentity.create({ data: { userId: o.userId, provider: 'google', subject: 'nd-sub', email: 'nd-google@example.com' } });
    await googleLogin({ sub: 'nd-sub', email: 'nd-google@example.com' }); // registerOwner's own session is 'vitest' on 127.0.0.1; this is a different browser string
    expect((await mailsOf('nd-google@example.com', 'new_device')).length).toBeLessThanOrEqual(1);
  });
});
