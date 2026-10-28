import { getToken } from 'next-auth/jwt';
import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, cspMode } from '@/lib/csp';
import { SECURE_COOKIES, SESSION_COOKIE, sessionIsLive } from '@/lib/session-cookie';

/**
 * Two jobs on every page request:
 *  1. the signed-in areas send a visitor with no live session to the sign-in page, and bring them back to where they were;
 *  2. every page gets a fresh Content-Security-Policy with a one-time nonce (lib/csp.ts). Next reads the nonce from the REQUEST's policy header and stamps it on its
 *     own scripts, so the response's header and the request's must carry the same policy.
 */
const PRIVATE = /^\/(dashboard|surveys|contacts|settings|billing|onboarding|simulator|integrations)(\/|$)/;

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const mode = cspMode();
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== 'production', https: SECURE_COOKIES });
  const header = mode === 'report-only' ? 'content-security-policy-report-only' : 'content-security-policy';

  if (PRIVATE.test(pathname)) {
    const token = await getToken({ req, cookieName: SESSION_COOKIE });
    if (!sessionIsLive(token)) {
      const to = new URL('/login', req.url);
      to.searchParams.set('callbackUrl', pathname + search);
      const res = NextResponse.redirect(to);
      if (token) res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', secure: SECURE_COOKIES, maxAge: 0 }); // run past its end: dropped
      return res;
    }
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  if (mode !== 'off') requestHeaders.set(header, csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  if (mode !== 'off') res.headers.set(header, csp);
  return res;
}

// Pages only: the API proxy, NextAuth's own routes and static files carry no HTML.
export const config = {
  matcher: [
    {
      source: '/((?!api/|proxy/|_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|txt|xml)$).*)',
      missing: [{ type: 'header', key: 'next-router-prefetch' }, { type: 'header', key: 'purpose', value: 'prefetch' }],
    },
  ],
};
