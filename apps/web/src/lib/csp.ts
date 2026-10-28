/**
 * The Content-Security-Policy (SEC-13): the browser runs only the scripts this site marked with a fresh one-time nonce (and what those load), refuses plugins,
 * framing by other sites and form posts elsewhere, and talks only to the places the product really uses. Built per request by the middleware.
 *
 * Why it looks the way it does:
 *  - `strict-dynamic` + nonce: Next's own scripts carry the nonce, and the scripts they add (Turnstile, the Meta SDK) are trusted through them. The host names are
 *    kept for old browsers that ignore strict-dynamic.
 *  - style-src allows inline styles: Radix and the charts set style attributes, which a nonce cannot cover. Inline STYLES cannot run code.
 *  - Cloudflare Turnstile (CAPTCHA) and Meta (Embedded Signup for WhatsApp) are the only third parties; Google is only a redirect (form-action).
 *  - Development needs eval for React Refresh and a web socket for hot reload.
 */
export function buildCsp(nonce: string, opts: { dev: boolean; https: boolean }): string {
  const meta = ['https://*.facebook.com', 'https://connect.facebook.net'];
  const directives: Array<[string, string[]]> = [
    ['default-src', [`'self'`]],
    ['script-src', [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`, 'https://challenges.cloudflare.com', 'https://connect.facebook.net', ...(opts.dev ? [`'unsafe-eval'`] : [])]],
    ['style-src', [`'self'`, `'unsafe-inline'`]],
    ['img-src', [`'self'`, 'data:', 'blob:', 'https://*.facebook.com', 'https://*.fbcdn.net']],
    ['font-src', [`'self'`, 'data:']],
    ['connect-src', [`'self'`, 'https://challenges.cloudflare.com', ...meta, ...(opts.dev ? ['ws:', 'wss:'] : [])]],
    ['frame-src', ['https://challenges.cloudflare.com', 'https://*.facebook.com']],
    ['form-action', [`'self'`, 'https://accounts.google.com']],
    ['frame-ancestors', [`'self'`]],
    ['base-uri', [`'self'`]],
    ['object-src', [`'none'`]],
  ];
  const parts = directives.map(([k, v]) => `${k} ${v.join(' ')}`);
  if (opts.https && !opts.dev) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

/** `enforce` (default), `report-only` (log violations in the browser console without blocking, for trying a change) or `off`. */
export const cspMode = (): 'enforce' | 'report-only' | 'off' => {
  const m = (process.env.CSP_MODE ?? '').trim().toLowerCase();
  return m === 'report-only' || m === 'off' ? m : 'enforce';
};
