import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/proxy/[...path]/route';
import { workspaceHeaders } from '@/lib/workspace';

/**
 * BIZ-04: the workspace a team member works on travels from the browser through the proxy to the API as a request, which the API checks on every call. The proxy
 * passes a well-formed id on, REFUSES a malformed one (dropping it would make somebody who thinks they are in a colleague's workspace act on their own data), and the
 * browser client attaches it only to the calls that belong to the workspace.
 */
const SECRET = process.env.NEXTAUTH_SECRET!;
const COOKIE = 'next-auth.session-token';
const cookie = () => encode({ token: { uid: 'u1', sid: 's1', apiToken: 'access', apiTokenExp: Date.now() + 600_000, refreshToken: 'refresh', sessionExp: Date.now() + 3_600_000 }, secret: SECRET, maxAge: 3600 });
const request = async (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new NextRequest(`http://localhost:4222/proxy/${path}`, { method, headers: { 'sec-fetch-site': 'same-origin', cookie: `${COOKIE}=${await cookie()}`, ...headers } });
let seen: Array<Headers>;
beforeEach(() => {
  seen = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => { seen.push(new Headers(init.headers)); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the proxy and the workspace header', () => {
  it('passes a well-formed workspace id on to the API, next to the member\'s own token', async () => {
    const res = await GET(await request('surveys', { 'x-workspace': 'cmvwdqoan00503g7dmlv' }), { params: Promise.resolve({ path: ['surveys'] }) });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get('x-workspace')).toBe('cmvwdqoan00503g7dmlv');
    expect(seen[0]!.get('authorization')).toBe('Bearer access');
  });

  it('adds nothing when the browser names no workspace (an owner who works alone is unchanged)', async () => {
    await GET(await request('surveys'), { params: Promise.resolve({ path: ['surveys'] }) });
    expect(seen[0]!.get('x-workspace')).toBeNull();
  });

  it('refuses anything that is not an id, and never calls the API with it', async () => {
    for (const bad of ['../etc/passwd', 'x', 'a b c d e f g h i j', 'id;drop', '<script>alert(1)</script>', 'a'.repeat(41), '']) {
      const res = await GET(await request('surveys', { 'x-workspace': bad }), { params: Promise.resolve({ path: ['surveys'] }) });
      expect([res.status, bad]).toEqual([400, bad]);
    }
    expect(seen).toHaveLength(0);
  });

  it('is passed on for writes too', async () => {
    const req = new NextRequest('http://localhost:4222/proxy/contacts', { method: 'POST', body: JSON.stringify({ name: 'x' }), headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie: `${COOKIE}=${await cookie()}`, 'x-workspace': 'cmvwdqoan00503g7dmlv' } });
    const res = await POST(req, { params: Promise.resolve({ path: ['contacts'] }) });
    expect(res.status).toBe(200);
    expect(seen[0]!.get('x-workspace')).toBe('cmvwdqoan00503g7dmlv');
  });
});

describe('the browser client: which calls name the workspace', () => {
  const storage = new Map<string, string>();
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });
  });

  it('none, with no workspace chosen', () => {
    expect(workspaceHeaders('/surveys')).toEqual({});
  });

  it('the workspace\'s calls name it; the person\'s own (sign-in and security, invitations, their own data) never do, except reading the account summary', () => {
    storage.set('sf.workspace', 'cmvwdqoan00503g7dmlv');
    const id = { 'x-workspace': 'cmvwdqoan00503g7dmlv' };
    for (const p of ['/surveys', '/surveys/abc/send', '/contacts', '/whatsapp/accounts']) expect(workspaceHeaders(p, 'POST'), p).toEqual(id);
    for (const p of ['/auth/sessions', '/auth/password/change', '/auth/2fa/setup', '/team/accept', '/team/workspaces', '/account/export', '/account/delete']) expect(workspaceHeaders(p, 'POST'), p).toEqual({});
    expect(workspaceHeaders('/auth/me', 'GET')).toEqual(id); // how the app learns the workspace's plan and the person's role
    expect(workspaceHeaders('/auth/me', 'PATCH')).toEqual({}); // editing a profile is the person's own
  });

  it('a stored value that is not an id is ignored', () => {
    storage.set('sf.workspace', '../../x');
    expect(workspaceHeaders('/surveys')).toEqual({});
  });
});
