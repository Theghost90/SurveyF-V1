import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { redis } from '../src/lib/redis';
import { makeApp, registerOwner, resetAll } from './helpers';

/**
 * SEC-18: the general limit counts per verified SESSION, not per shared address (many owners sit behind one public address on a mobile network), calls with no valid
 * token count per address, and a higher cap per address stops one source from multiplying sessions.
 */
let app: FastifyInstance;
const saved = { session: env.RATE_LIMIT_SESSION_PER_MINUTE, ip: env.RATE_LIMIT_IP_PER_MINUTE };
beforeAll(async () => { app = await makeApp(); });
beforeEach(async () => { await resetAll(); });
afterEach(() => { Object.assign(env, { RATE_LIMIT_SESSION_PER_MINUTE: saved.session, RATE_LIMIT_IP_PER_MINUTE: saved.ip }); });
afterAll(async () => { await app.close(); redis.disconnect(); });

// The shared secret is not set under test, so the visitor address header is believed: it stands in for "another visitor".
const call = (token: string | undefined, ip: string, url = '/api/auth/me') =>
  app.inject({ method: 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-sf-client-ip': ip } });
const statuses = async (n: number, f: (i: number) => Promise<{ statusCode: number }>) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push((await f(i)).statusCode); return out; };

describe('the general limit counts per session', () => {
  it('two owners behind the same address each get their own allowance', async () => {
    env.RATE_LIMIT_SESSION_PER_MINUTE = 5;
    const a = await registerOwner(app);
    const b = await registerOwner(app);
    expect(await statuses(7, () => call(a.token, '10.1.0.1'))).toEqual([200, 200, 200, 200, 200, 429, 429]);
    // b is behind the same address and has used nothing
    expect(await statuses(5, () => call(b.token, '10.1.0.1'))).toEqual([200, 200, 200, 200, 200]);
    expect((await call(b.token, '10.1.0.1')).statusCode).toBe(429);
  });

  it('the answer to a refused call is the usual rate_limited error', async () => {
    env.RATE_LIMIT_SESSION_PER_MINUTE = 2;
    const a = await registerOwner(app);
    await statuses(2, () => call(a.token, '10.1.1.1'));
    const r = await call(a.token, '10.1.1.1');
    expect(r.statusCode).toBe(429);
    expect(JSON.parse(r.body).error).toBe('rate_limited');
  });

  it('calls with no token count per address: another visitor is not slowed by this one', async () => {
    env.RATE_LIMIT_SESSION_PER_MINUTE = 5;
    expect(await statuses(6, () => call(undefined, '10.2.0.1', '/api/pricing'))).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await call(undefined, '10.2.0.2', '/api/pricing')).statusCode).toBe(200);
  });

  it('a token this server did not sign cannot pick a session to land in a fresh allowance: it counts against the address', async () => {
    env.RATE_LIMIT_SESSION_PER_MINUTE = 5;
    const forge = (sid: string) => new SignJWT({ sid }).setProtectedHeader({ alg: 'HS256', kid: 'deadbeef' }).setSubject('someone').setIssuer('surveyflow').setAudience('surveyflow-api')
      .setExpirationTime('5m').sign(new TextEncoder().encode('another-secret-another-secret-1234567'));
    const codes = await statuses(7, async (i) => call(await forge(`invented-session-${i}`), '10.2.1.1'));
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429]); // a different invented session each time would never have been counted if the id were trusted
  });

  it('a token whose session ended still counts against that session (and is refused by the auth hook, not by luck)', async () => {
    env.RATE_LIMIT_SESSION_PER_MINUTE = 3;
    const a = await registerOwner(app);
    expect((await a.post('/api/auth/logout')).status).toBe(204); // counts as the first of the 3
    expect(await statuses(3, () => call(a.token, '10.2.2.1'))).toEqual([401, 401, 429]);
  });
});

describe('the ceiling per address', () => {
  it('many sessions from one address share one ceiling, other addresses are unaffected', async () => {
    env.RATE_LIMIT_IP_PER_MINUTE = 6;
    const owners = [await registerOwner(app), await registerOwner(app), await registerOwner(app)];
    expect(await statuses(8, (i) => call(owners[i % 3]!.token, '10.3.0.1'))).toEqual([200, 200, 200, 200, 200, 200, 429, 429]);
    const refused = await call(owners[0]!.token, '10.3.0.1');
    expect(refused.headers['retry-after']).toBe('60');
    expect((await call(owners[0]!.token, '10.3.0.2')).statusCode).toBe(200);
  });

  it('Meta\'s webhook is not counted against the address', async () => {
    env.RATE_LIMIT_IP_PER_MINUTE = 3;
    const codes = await statuses(8, () => call(undefined, '10.3.1.1', '/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1'));
    expect(codes.includes(429)).toBe(false);
  });
});
