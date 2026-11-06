/**
 * Rules the website applies to what a visitor's browser asks of it. Pure string logic, kept here (not in the Next route files) so that it is read in one
 * place and tested without a browser: see web-guard.test.ts.
 */

// ---- the API proxy (apps/web/src/app/proxy/[...path]/route.ts) --------------------------------------------------------------------------

/** Calls that work without a session: the sign-up and e-mail-link flows, and what the forms need to know. Everything else needs the cookie. */
export const PROXY_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  'auth/register', 'auth/config', 'auth/verify-email', 'auth/verify-email/resend', 'auth/password/forgot', 'auth/password/reset', 'auth/google/link/confirm',
  'dev/mailbox', // the demo mailbox: exists only when the API uses the mock e-mail provider outside production
]);

/**
 * Never reachable from a browser, signed in or not: signing in and renewing a session are done by the website's server alone (the password and the refresh
 * token never travel through page scripts), and webhooks are for Meta and the payment providers talking to the API directly.
 */
export const PROXY_NEVER_FROM_BROWSER = /^(auth\/(login|refresh|google|signout|logout)$|webhook\/|.*\/webhook\/)/i; // case-blind: the list must not depend on how the API's router treats case

/**
 * What one piece of the address may look like: an id, a token, a file name. NOTHING that could change the path or the query once the pieces are put back
 * into a URL. Next hands the route its pieces already decoded, so `contacts%2F..%2Fauth%2Flogin` arrives as ONE piece containing slashes and dots, and
 * `auth/login%3Fx=1` as a piece containing a question mark: both slipped past the list above (found by probing the running proxy) and reached routes the
 * website's server keeps to itself. A piece with any other character is refused outright.
 */
const SEGMENT = /^[A-Za-z0-9._~-]{1,200}$/;
export const PROXY_MAX_SEGMENTS = 12;

export type ProxyVerdict =
  | 'bad_request' // not plain pieces of an address
  | 'never' // a route that only the website's server may call
  | 'public' // works without a session
  | 'session'; // needs the signed-in cookie

export function proxyVerdict(segments: readonly string[] | undefined): ProxyVerdict {
  if (!segments || segments.length === 0 || segments.length > PROXY_MAX_SEGMENTS) return 'bad_request';
  if (!segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) return 'bad_request';
  const path = segments.join('/');
  if (PROXY_NEVER_FROM_BROWSER.test(path)) return 'never';
  return PROXY_PUBLIC_PATHS.has(path) ? 'public' : 'session';
}

// ---- where to go after signing in ------------------------------------------------------------------------------------------------------

/**
 * A path on THIS site, or the fallback: never another site (an open redirect after sign-in is a phishing aid: the visitor really did sign in to the real
 * site, then lands on a copy of it). One leading slash, then not another slash or a BACKSLASH (browsers read `/\evil.example` as `//evil.example`), and no
 * control characters or spaces.
 */
export function safeRelativePath(raw: string | null | undefined, fallback = '/dashboard'): string {
  if (!raw || raw.length > 1000) return fallback;
  return /^\/(?![/\\])[^\\\u0000- \u007f]*$/.test(raw) ? raw : fallback;
}
