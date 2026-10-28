import { NextRequest, NextResponse } from 'next/server';
import { encode, getToken, type JWT } from 'next-auth/jwt';
import { proxyVerdict } from '@surveyflow/shared';
import { API_URL, internalHeaders } from '@/lib/auth';
import { renewApiToken, type Renewed } from '@/lib/api-session';
import { forwardedFrom } from '@/lib/client-ip';
import { readCapped } from '@/lib/read-capped';
import { SECURE_COOKIES, SESSION_COOKIE, SESSION_SECONDS } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: SECURE_COOKIES };

/** An export can take a while to render; a call still running after this is given up (and the page is told the API is not reachable). */
const UPSTREAM_TIMEOUT_MS = 120_000;

const refuse = (status: number, error: string, message?: string) => NextResponse.json(message ? { error, message } : { error }, { status });

async function handler(req: NextRequest, { params }: { params: { path: string[] } }) {
  const segments = params.path;
  // Only plain pieces: no traversal out of /api, no smuggled slash, question mark or percent sign (packages/shared/src/web-guard.ts says why).
  const verdict = proxyVerdict(segments);
  if (verdict === 'bad_request') return refuse(400, 'bad_request');
  // CSRF defence in depth (the session cookie is already SameSite=Lax): this proxy is called only by this site's own pages. A request that another site's page
  // (or a sibling sub-domain's) caused is refused, and so is a state-changing one whose Origin is not ours. `none` is the owner typing or opening the address
  // themselves, which is fine for a read (a download) and never happens for a write.
  const site = req.headers.get('sec-fetch-site');
  const stateChanging = !['GET', 'HEAD'].includes(req.method);
  if (site && site !== 'same-origin' && !(site === 'none' && !stateChanging)) return refuse(403, 'forbidden', 'Cross-origin request refused');
  if (stateChanging) {
    const origin = req.headers.get('origin');
    const allowed = new Set([req.nextUrl.origin, process.env.NEXTAUTH_URL ? new URL(process.env.NEXTAUTH_URL).origin : '']);
    if (origin && !allowed.has(origin)) return refuse(403, 'forbidden', 'Cross-origin request refused');
  }
  if (verdict === 'never') return refuse(404, 'not_found');
  const isPublic = verdict === 'public';

  const cookie = (await getToken({ req, cookieName: SESSION_COOKIE })) as JWT | null;
  const live = !!cookie?.apiToken && !!cookie.refreshToken && !!cookie.sid && !cookie.error && (cookie.sessionExp ?? 0) > Date.now();
  if (!live && !isPublic) {
    const res = refuse(401, 'unauthorized', 'Authentication required');
    if (cookie) res.cookies.set(SESSION_COOKIE, '', { ...cookieOptions, maxAge: 0 }); // a cookie that has run past its end is dropped
    return res;
  }

  // Read the body BEFORE anything can rotate the refresh token: a request refused after a renewal would lose the new cookie.
  let body: ArrayBuffer | undefined;
  if (!['GET', 'HEAD'].includes(req.method)) {
    const read = await readCapped(req);
    if (read === 'too_large') return refuse(413, 'payload_too_large', 'That request is too large');
    body = read;
  }

  const forwarded = forwardedFrom(req.headers);
  const base = new Headers(internalHeaders());
  const ct = req.headers.get('content-type');
  if (ct) base.set('content-type', ct);
  base.set('accept', req.headers.get('accept') ?? 'application/json');
  for (const [k, v] of Object.entries(forwarded)) base.set(k, v);

  // The API token as it stands, and what happened when it had to be renewed during this request.
  const state: { apiToken: string | undefined; renewed: Renewed | null; ended: boolean } = { apiToken: isPublic ? undefined : cookie!.apiToken, renewed: null, ended: false };

  const renew = async (): Promise<'ok' | 'ended' | 'unavailable'> => {
    const r = await renewApiToken(cookie!.sid!, cookie!.refreshToken!, forwarded);
    if (r === 'ended') { state.ended = true; return 'ended'; }
    if (r === 'unavailable') return 'unavailable';
    state.renewed = r;
    state.apiToken = r.accessToken;
    return 'ok';
  };

  /**
   * Whatever the answer is, if this request changed the sign-in the browser must hear of it: a renewal that rotated the refresh token and whose new value never
   * reached the cookie would sign the owner out at the next renewal (the old token is honoured for a few seconds only), and an ended session must drop its cookie.
   */
  const withCookie = async (res: NextResponse): Promise<NextResponse> => {
    if (state.ended) {
      res.cookies.set(SESSION_COOKIE, '', { ...cookieOptions, maxAge: 0 });
    } else if (state.renewed?.refreshToken) {
      // When the API answered "keep what you have" (refreshToken null: a parallel request rotated it) the cookie is left alone, so the newer one that
      // request set is not overwritten.
      const r = state.renewed;
      const token = await encode({
        token: { ...cookie, apiToken: r.accessToken, apiTokenExp: r.accessTokenExp, refreshToken: r.refreshToken!, sessionExp: r.sessionExp },
        secret: process.env.NEXTAUTH_SECRET!,
        maxAge: SESSION_SECONDS,
      });
      res.cookies.set(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_SECONDS });
    }
    return res;
  };
  const unavailable = () => withCookie(refuse(502, 'upstream_unreachable', 'The API is not reachable'));

  // Renew a little before the token runs out, so a request does not have to fail first.
  if (!isPublic && (cookie!.apiTokenExp ?? 0) - Date.now() < 30_000) {
    if ((await renew()) === 'unavailable') return unavailable();
  }

  const url = `${API_URL}/api/${segments.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const send = () => {
    const headers = new Headers(base);
    if (state.apiToken) headers.set('authorization', `Bearer ${state.apiToken}`);
    return fetch(url, { method: req.method, headers, body, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  };

  let upstream: Response;
  try {
    upstream = state.ended ? new Response(JSON.stringify({ error: 'unauthorized', message: 'Session ended' }), { status: 401, headers: { 'content-type': 'application/json' } }) : await send();
    // The API says the token is not good (revoked, or our clock disagreed): ask once for a new one and repeat the call. Only for the API's own "unauthorized":
    // other 401s (a wrong password, a wrong code) are answers, and repeating them would count a guess twice.
    if (!state.ended && !isPublic && upstream.status === 401 && !state.renewed) {
      const said = (await upstream.clone().json().catch(() => null)) as { error?: string } | null;
      if (said?.error === 'unauthorized') {
        const r = await renew();
        if (r === 'unavailable') return unavailable();
        if (r === 'ok') upstream = await send();
      }
    }
  } catch {
    return unavailable();
  }

  const out = new Headers();
  for (const h of ['content-type', 'content-disposition', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set('cache-control', 'no-store');
  return withCookie(new NextResponse(upstream.status === 204 ? null : upstream.body, { status: upstream.status, headers: out }));
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
