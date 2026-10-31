import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Found by the SEC-07 check through a real Cloudflare edge: the sign-in lines of the activity list showed the visitor's address, the two sign-out lines showed
 * 127.0.0.1 and "unknown system". The website's server makes the sign-out calls itself and forwarded nothing about the visitor; it also made two calls (two lines).
 */
const visitor = new Headers({ 'cf-connecting-ip': '102.244.220.7', 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130' });
let current: Headers | Error = visitor;
vi.mock('next/headers', () => ({ headers: async () => { if (current instanceof Error) throw current; return current; } }));

const calls: Array<{ url: string; headers: Record<string, string> }> = [];
beforeEach(() => {
  calls.length = 0; current = visitor;
  vi.stubEnv('CLIENT_IP_HEADER', 'cf-connecting-ip');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => { calls.push({ url, headers: init.headers }); return new Response(null, { status: 204 }); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const signOut = async (token: Record<string, unknown>) => { const { authOptions } = await import('@/lib/auth'); await authOptions.events!.signOut!({ token } as never); };

describe('signing out tells the API who is signing out', () => {
  it('a live API token: ONE call ("logout") carrying the visitor\'s address and browser', async () => {
    await signOut({ apiToken: 'tok', apiTokenExp: Date.now() + 60_000, refreshToken: 'rt' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/api\/auth\/logout$/);
    expect(calls[0]!.headers).toMatchObject({ 'x-sf-client-ip': '102.244.220.7', 'user-agent': expect.stringContaining('Android'), authorization: 'Bearer tok' });
  });

  it('an API token that has run out: ONE call ("signout" by refresh token), with the same facts', async () => {
    await signOut({ apiToken: 'tok', apiTokenExp: Date.now() - 1000, refreshToken: 'rt' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/api\/auth\/signout$/);
    expect(calls[0]!.headers).toMatchObject({ 'x-sf-client-ip': '102.244.220.7' });
  });

  it('with no request around it the address is simply unknown, and signing out still works', async () => {
    current = new Error('no request');
    await signOut({ apiToken: 'tok', apiTokenExp: Date.now() + 60_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-sf-client-ip']).toBeUndefined();
  });

  it('a visitor-typed forwarding header changes nothing: only the configured CDN header is believed', async () => {
    current = new Headers({ 'cf-connecting-ip': '102.244.220.7', 'x-forwarded-for': '6.6.6.6' });
    await signOut({ apiToken: 'tok', apiTokenExp: Date.now() + 60_000 });
    expect(calls[0]!.headers['x-sf-client-ip']).toBe('102.244.220.7');
  });
});
