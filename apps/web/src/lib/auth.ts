import type { NextAuthOptions } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import { headers as nextHeaders } from 'next/headers';
import { forwardedFrom, headerGetter } from './client-ip';
import { SECURE_COOKIES, SESSION_COOKIE, SESSION_SECONDS, sessionIsLive } from './session-cookie';

export const API_URL = process.env.API_URL ?? 'http://localhost:4223';
/** The website's server proves who it is to the API with a shared secret; the API refuses every non-public call without it. Server-side only. */
export const internalHeaders = (): Record<string, string> => (process.env.INTERNAL_API_SECRET ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET } : {});
const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.INTERNAL_API_SECRET);
export const googleSignInEnabled = googleEnabled;

/** What the API answers to a sign-in (password or Google). */
interface ApiSignIn {
  sessionId: string; accessToken: string; accessTokenExpiresAt: string; refreshToken: string; sessionExpiresAt: string;
  user: { id: string; email: string; name: string };
}

const toUser = (b: ApiSignIn) => ({
  id: b.user.id, email: b.user.email, name: b.user.name,
  sid: b.sessionId, apiToken: b.accessToken, apiTokenExp: Date.parse(b.accessTokenExpiresAt), refreshToken: b.refreshToken, sessionExp: Date.parse(b.sessionExpiresAt),
});

/**
 * NextAuth passes a thrown error's message to the page as `error`. These are the stable codes the sign-in form understands:
 *   totp_required · invalid_code · captcha_required · captcha_failed · login_delayed:<seconds> · invalid_credentials · server_error · network
 */
function loginError(res: Response, body: { error?: string; details?: { retryAfter?: number } } | null): string {
  switch (body?.error) {
    case 'totp_required': case 'invalid_code': case 'captcha_required': case 'captcha_failed': return body.error;
    case 'login_delayed': return `login_delayed:${Math.max(1, Math.ceil(Number(body.details?.retryAfter ?? 2)))}`;
    default:
      // The per-minute cap on attempts (a plain 429): "wait", never "wrong password", which would send a legitimate owner to reset a password that is fine.
      if (res.status === 429) return `login_delayed:${Math.min(120, Math.max(5, Math.ceil(Number(res.headers.get('retry-after')) || 30)))}`;
      return res.status >= 500 ? 'server_error' : 'invalid_credentials';
  }
}

export const authOptions: NextAuthOptions = {
  // The browser session is one encrypted cookie. It ends when the API session does (SESSION_TTL_HOURS), not when the page is left open.
  session: { strategy: 'jwt', maxAge: SESSION_SECONDS },
  jwt: { maxAge: SESSION_SECONDS },
  pages: { signIn: '/login', error: '/login' },
  cookies: { sessionToken: { name: SESSION_COOKIE, options: { httpOnly: true, sameSite: 'lax', path: '/', secure: SECURE_COOKIES } } },
  providers: [
    Credentials({
      name: 'Email and password',
      credentials: {
        email: { label: 'Email', type: 'email' }, password: { label: 'Password', type: 'password' },
        totp: { label: 'Code', type: 'text' }, recoveryCode: { label: 'Recovery code', type: 'text' }, captchaToken: { label: 'CAPTCHA', type: 'text' },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials.password) throw new Error('invalid_credentials');
        let res: Response;
        try {
          res = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            // The visitor's real address, browser and country travel with the call, so the limits and the security log are about the person, not this server.
            headers: { 'Content-Type': 'application/json', ...internalHeaders(), ...forwardedFrom(headerGetter(req?.headers ?? {})) },
            body: JSON.stringify({
              email: credentials.email, password: credentials.password,
              ...(credentials.totp ? { totp: credentials.totp } : {}), ...(credentials.recoveryCode ? { recoveryCode: credentials.recoveryCode } : {}),
              ...(credentials.captchaToken ? { captchaToken: credentials.captchaToken } : {}),
            }),
            cache: 'no-store',
          });
        } catch {
          throw new Error('network');
        }
        const body = (await res.json().catch(() => null)) as (ApiSignIn & { error?: string; details?: { retryAfter?: number } }) | null;
        if (!res.ok || !body?.accessToken) throw new Error(loginError(res, body));
        return toUser(body);
      },
    }),
    ...(googleEnabled ? [Google({ clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! })] : []),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== 'google') return true;
      // Google's ID TOKEN goes to the API, which checks Google's signature, our client id and the verified e-mail itself: this server's word is not enough.
      if (!account.id_token) return false;
      let res: Response;
      try {
        res = await fetch(`${API_URL}/api/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...internalHeaders(), ...forwardedFrom(headerGetter(await nextHeaders())) },
          body: JSON.stringify({ idToken: account.id_token }),
          cache: 'no-store',
        });
      } catch {
        return false;
      }
      // That address already has an account: its owner was e-mailed a link, and nothing is linked until they click it.
      if (res.status === 202) return '/login?google=link';
      if (!res.ok) return false;
      Object.assign(user, toUser((await res.json()) as ApiSignIn));
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        Object.assign(token, { uid: user.id, sid: user.sid, apiToken: user.apiToken, apiTokenExp: user.apiTokenExp, refreshToken: user.refreshToken, sessionExp: user.sessionExp });
        delete token.error;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = token.uid ?? (token.sub as string);
      // Never the tokens: the page learns only whether the sign-in is still good.
      if (!sessionIsLive(token)) session.error = 'SessionExpired';
      return session;
    },
  },
  events: {
    /** Signing out also ends the session at the API, so a copy of the cookie is useless from this moment. Best effort: signing out never waits on it. */
    async signOut({ token }) {
      const calls: Promise<unknown>[] = [];
      if (token?.refreshToken) {
        calls.push(fetch(`${API_URL}/api/auth/signout`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() }, body: JSON.stringify({ refreshToken: token.refreshToken }), cache: 'no-store' }));
      }
      if (token?.apiToken) calls.push(fetch(`${API_URL}/api/auth/logout`, { method: 'POST', headers: { ...internalHeaders(), authorization: `Bearer ${token.apiToken}` }, cache: 'no-store' }));
      await Promise.allSettled(calls);
    },
  },
};
