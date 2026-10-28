import { decode, encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/proxy/[...path]/route';

/**
 * The website's API proxy renews the API token from the refresh token and writes the new pair back into the browser's cookie. What matters, and what these tests hold:
 * the browser always hears of a renewal (a rotated refresh token whose new value never reached the cookie signs the owner out at the next renewal), an API that
 * cannot be asked costs the owner nothing, a refused request does not rotate anything, and one old copy of a cookie is never handed the legitimate owner's new tokens.
 */
const SECRET = process.env.NEXTAUTH_SECRET!;
const COOKIE = 'next-auth.session-token'; // NEXTAUTH_URL is http in the tests: no __Secure- prefix
const NOW = () => Date.now();

const sessionCookie = (over: Record<string, unknown> = {}) =>
  encode({ token: { uid: 'u1', sid: 's1', apiToken: 'old-access', apiTokenExp: NOW() + 600_000, refreshToken: 'old-refresh', sessionExp: NOW() + 3_600_000, ...over }, secret: SECRET, maxAge: 3600 });

const request = async (path: string, init: { method?: string; body?: string; headers?: Record<string, string>; cookie?: Record<string, unknown> | false } = {}) =>
  new NextRequest(`http://localhost:4222/proxy/${path}`, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: { 'sec-fetch-site': 'same-origin', ...(init.cookie === false ? {} : { cookie: `${COOKIE}=${await sessionCookie(init.cookie)}` }), ...init.headers },
  });
const run = (req: NextRequest, path: string, method: typeof GET | typeof POST = GET) => method(req, { params: Promise.resolve({ path: path.split('/') }) });
const cookieOf = async (res: Response) => {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));
  if (!header) return null;
  const value = header.slice(COOKIE.length + 1).split(';')[0]!;
  return { header, token: value ? await decode({ token: value, secret: SECRET }) : null };
};

type Reply = Response | Error;
interface Api { refresh: Reply[]; call: Reply[]; seen: Array<{ url: string; auth: string | null; body: string | null }> }
let api: Api;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const renewed = (over: Record<string, unknown> = {}) => json({ accessToken: 'new-access', accessTokenExpiresAt: new Date(NOW() + 600_000).toISOString(), refreshToken: 'new-refresh', sessionExpiresAt: new Date(NOW() + 3_600_000).toISOString(), ...over });
const refreshCalls = () => api.seen.filter((s) => s.url.endsWith('/api/auth/refresh'));
const dataCalls = () => api.seen.filter((s) => !s.url.endsWith('/api/auth/refresh'));

beforeEach(() => {
  api = { refresh: [], call: [], seen: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    api.seen.push({ url: String(url), auth: headers.get('authorization'), body: typeof init.body === 'string' ? init.body : init.body ? new TextDecoder().decode(init.body as ArrayBuffer) : null });
    const queue = String(url).endsWith('/api/auth/refresh') ? api.refresh : api.call;
    const next = queue.shift() ?? (String(url).endsWith('/api/auth/refresh') ? renewed() : json({ ok: true }));
    if (next instanceof Error) throw next;
    return next.clone();
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('renewing the API token', () => {
  it('a token about to run out is renewed before the call, the call uses the new one, and the cookie carries the new pair', async () => {
    const res = await run(await request('surveys', { cookie: { apiTokenExp: NOW() + 5_000 } }), 'surveys');
    expect(res.status).toBe(200);
    expect(refreshCalls()).toHaveLength(1);
    expect(JSON.parse(refreshCalls()[0]!.body!)).toEqual({ refreshToken: 'old-refresh' });
    expect(dataCalls()).toHaveLength(1);
    expect(dataCalls()[0]!.auth).toBe('Bearer new-access');
    const set = await cookieOf(res);
    expect(set?.token).toMatchObject({ uid: 'u1', sid: 's1', apiToken: 'new-access', refreshToken: 'new-refresh' });
    expect(set?.header).toMatch(/HttpOnly/i);
    expect(set?.header).toMatch(/SameSite=lax/i);
  });

  it('a token with time left is used as it is: nothing is renewed, the cookie is not touched', async () => {
    const res = await run(await request('surveys'), 'surveys');
    expect(res.status).toBe(200);
    expect(refreshCalls()).toHaveLength(0);
    expect(dataCalls()[0]!.auth).toBe('Bearer old-access');
    expect(await cookieOf(res)).toBeNull();
  });

  it('a renewal whose call then fails still hands the browser the new cookie (the new refresh token must not be lost)', async () => {
    api.call.push(new Error('connection reset'));
    const res = await run(await request('surveys', { cookie: { apiTokenExp: NOW() + 5_000 } }), 'surveys');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'upstream_unreachable' });
    expect((await cookieOf(res))?.token).toMatchObject({ apiToken: 'new-access', refreshToken: 'new-refresh' });
  });

  it('when the API cannot be asked to renew (it is down or too slow) the owner keeps their cookie as it was', async () => {
    for (const failure of [json({ error: 'boom' }, 500), new Error('timeout')]) {
      api = { ...api, refresh: [failure], call: [], seen: [] };
      const res = await run(await request('surveys', { cookie: { apiTokenExp: NOW() + 5_000, refreshToken: `r-${Math.random()}` } }), 'surveys');
      expect(res.status).toBe(502);
      expect(await cookieOf(res)).toBeNull();
      expect(dataCalls()).toHaveLength(0);
    }
  });

  it('a session the API says is over drops the cookie', async () => {
    api.refresh.push(json({ error: 'unauthorized' }, 401));
    const res = await run(await request('surveys', { cookie: { apiTokenExp: NOW() + 5_000, refreshToken: 'ended-refresh' } }), 'surveys');
    expect(res.status).toBe(401);
    const set = await cookieOf(res);
    expect(set?.token).toBeNull();
    expect(set?.header).toMatch(/Max-Age=0/i);
  });

  it('"keep what you have" (another request already rotated the token) leaves the cookie alone, but the call goes through with the new access token', async () => {
    api.refresh.push(renewed({ refreshToken: null }));
    const res = await run(await request('surveys', { cookie: { apiTokenExp: NOW() + 5_000, refreshToken: 'rotated-elsewhere' } }), 'surveys');
    expect(res.status).toBe(200);
    expect(dataCalls()[0]!.auth).toBe('Bearer new-access');
    expect(await cookieOf(res)).toBeNull();
  });

  it('the API\'s own "unauthorized" renews once and repeats the call once; any other 401 is an answer and is not repeated', async () => {
    api.call.push(json({ error: 'unauthorized' }, 401));
    const retried = await run(await request('surveys', { cookie: { refreshToken: 'retry-refresh' } }), 'surveys');
    expect(retried.status).toBe(200);
    expect(refreshCalls()).toHaveLength(1);
    expect(dataCalls().map((c) => c.auth)).toEqual(['Bearer old-access', 'Bearer new-access']);
    expect((await cookieOf(retried))?.token).toMatchObject({ refreshToken: 'new-refresh' });

    api = { ...api, refresh: [], call: [json({ error: 'invalid_code' }, 401)], seen: [] };
    const answer = await run(await request('auth/step-up', { method: 'POST', body: '{"secret":"x"}', headers: { 'content-type': 'application/json', origin: 'http://localhost:4222' }, cookie: { refreshToken: 'answer-refresh' } }), 'auth/step-up', POST);
    expect(answer.status).toBe(401);
    expect(refreshCalls()).toHaveLength(0);
    expect(dataCalls()).toHaveLength(1); // a wrong code is counted once, not twice
  });

  it('requests that arrive together with the same refresh token share one renewal', async () => {
    const cookie = { apiTokenExp: NOW() + 5_000, refreshToken: 'shared-refresh' };
    const [a, b] = await Promise.all([run(await request('surveys', { cookie }), 'surveys'), run(await request('contacts', { cookie }), 'contacts')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('an OLDER copy of the cookie is never handed the new tokens another request just obtained: it renews on its own, with its own token', async () => {
    api.refresh.push(renewed({ refreshToken: 'fresh-for-owner' }), json({ error: 'unauthorized' }, 401));
    const owner = await run(await request('surveys', { cookie: { apiTokenExp: NOW() + 5_000, refreshToken: 'current-refresh' } }), 'surveys');
    const thief = await run(await request('surveys', { cookie: { apiTokenExp: NOW() + 5_000, refreshToken: 'stolen-older-refresh' } }), 'surveys');
    expect(owner.status).toBe(200);
    expect(thief.status).toBe(401); // the API refused the replayed token; the copy got nothing of the owner's
    expect(refreshCalls().map((c) => JSON.parse(c.body!).refreshToken)).toEqual(['current-refresh', 'stolen-older-refresh']);
    expect(dataCalls().filter((c) => c.auth === 'Bearer new-access')).toHaveLength(1); // only the owner's own call carried the owner's new token
    expect((await cookieOf(thief))?.token).toBeNull();
  });
});

describe('what is refused before anything is renewed', () => {
  it('a body over the limit is refused with nothing sent anywhere, so no refresh token is rotated for a request that goes nowhere', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024 + 10);
    const res = await run(await request('contacts/import', { method: 'POST', body: big, headers: { origin: 'http://localhost:4222' }, cookie: { apiTokenExp: NOW() + 5_000, refreshToken: 'big-refresh' } }), 'contacts/import', POST);
    expect(res.status).toBe(413);
    expect(api.seen).toHaveLength(0);
    expect(await cookieOf(res)).toBeNull();
  });

  it('another site\'s request is refused, and so is a write whose Origin is not ours; the owner opening an address is fine for a read', async () => {
    expect((await run(await request('surveys', { headers: { 'sec-fetch-site': 'cross-site' } }), 'surveys')).status).toBe(403);
    expect((await run(await request('surveys', { headers: { 'sec-fetch-site': 'same-site' } }), 'surveys')).status).toBe(403);
    const write = await run(await request('surveys', { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } }), 'surveys', POST);
    expect(write.status).toBe(403);
    expect((await run(await request('surveys', { headers: { 'sec-fetch-site': 'none' } }), 'surveys')).status).toBe(200);
    expect((await run(await request('surveys', { method: 'POST', body: '{}', headers: { 'sec-fetch-site': 'none', origin: 'http://localhost:4222' } }), 'surveys', POST)).status).toBe(403);
    expect(api.seen.length).toBe(1); // only the one allowed read reached the API
  });

  it('routes the website keeps to itself, and addresses that are not plain pieces, never reach the API', async () => {
    expect((await run(await request('auth/login', { method: 'POST', body: '{}', headers: { origin: 'http://localhost:4222' } }), 'auth/login', POST)).status).toBe(404);
    expect((await run(await request('auth/refresh', { method: 'POST', body: '{}', headers: { origin: 'http://localhost:4222' } }), 'auth/refresh', POST)).status).toBe(404);
    const smuggled = new NextRequest('http://localhost:4222/proxy/x', { headers: { 'sec-fetch-site': 'same-origin', cookie: `${COOKIE}=${await sessionCookie()}` } });
    expect((await GET(smuggled, { params: Promise.resolve({ path: ['contacts/../auth/login'] }) })).status).toBe(400);
    expect((await GET(smuggled, { params: Promise.resolve({ path: ['auth', 'login?x=1'] }) })).status).toBe(400);
    expect(api.seen).toHaveLength(0);
  });

  it('without a live session a protected call is refused (and a dead cookie dropped), while the sign-up flow works without one', async () => {
    const none = await run(await request('surveys', { cookie: false }), 'surveys');
    expect(none.status).toBe(401);
    expect(await cookieOf(none)).toBeNull();
    const expired = await run(await request('surveys', { cookie: { sessionExp: NOW() - 1000 } }), 'surveys');
    expect(expired.status).toBe(401);
    expect((await cookieOf(expired))?.header).toMatch(/Max-Age=0/i);
    expect(api.seen).toHaveLength(0);
    const open = await run(await request('auth/config', { cookie: false }), 'auth/config');
    expect(open.status).toBe(200);
    expect(dataCalls()[0]!.auth).toBeNull();
  });

  it('the shared secret travels to the API on every call, and the visitor\'s own headers are not forwarded wholesale', async () => {
    const seenHeaders: Headers[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => { seenHeaders.push(new Headers(init.headers)); return json({ ok: true }); }));
    await run(await request('surveys', { headers: { 'x-internal-secret': 'visitor-picked', 'x-sf-client-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6' } }), 'surveys');
    expect(seenHeaders[0]!.get('x-internal-secret')).toBe('test-internal-secret');
    expect(seenHeaders[0]!.get('x-sf-client-ip')).toBeNull(); // no CLIENT_IP_HEADER configured: unknown, never the visitor's own claim
    expect(seenHeaders[0]!.get('x-forwarded-for')).toBeNull();
  });
});
