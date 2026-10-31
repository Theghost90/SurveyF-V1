/**
 * What the browser session cookie is called and when its content is still good. Shared by the middleware (edge runtime: nothing here may need Node), the
 * sign-in configuration and the API proxy, so that all three agree.
 *
 * The cookie is NextAuth's own encrypted JWT. Besides who the owner is it holds the API's short-lived access token and the refresh token that renews it
 * (finding 3): both stay in this httpOnly cookie, the page scripts never see either, and the proxy renews the access token when it runs out.
 */
export const SECURE_COOKIES = (process.env.NEXTAUTH_URL ?? '').startsWith('https://');
export const SESSION_COOKIE = `${SECURE_COOKIES ? '__Secure-' : ''}next-auth.session-token`;
/** The browser session lasts as long as the API session (SESSION_TTL_HOURS, 12 by default: the API's own default). */
export const SESSION_SECONDS = Math.round((Number(process.env.SESSION_TTL_HOURS) || 12) * 3600);

export interface SessionTokenFields {
  uid?: string;
  sid?: string;
  apiToken?: string;
  /** When the API token stops working (ms since the epoch). */
  apiTokenExp?: number;
  refreshToken?: string;
  /** The absolute end of the sign-in (ms since the epoch). After it the owner signs in again, whatever they do. */
  sessionExp?: number;
  error?: string;
}

/** True while the cookie holds a sign-in that has not run past its absolute end. */
export const sessionIsLive = (t: SessionTokenFields | null | undefined, now = Date.now()): boolean =>
  !!t?.apiToken && !!t.refreshToken && !t.error && (t.sessionExp ?? 0) > now;
